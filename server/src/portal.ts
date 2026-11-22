import crypto from "node:crypto";
import { Router, type Response } from "express";
import { AppointmentStatus, NotificationChannel, NotificationDeliveryStatus, PortalAccessScope, PortalChallengePurpose, Prisma, QueueEntryStatus, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { auditLogData, getClientIp, hashToken, requireAuth, requireRole, type AuthenticatedRequest } from "./auth.js";
import { env } from "./config/env.js";
import { prisma } from "./db.js";
import { DeliveryUnavailableError, sendPortalEmail } from "./notification-delivery.js";

export const portalRouter = Router();

const portalRole = requireRole(Role.PATIENT);
const administratorOrReceptionist = requireRole(Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN, Role.RECEPTIONIST);
const departmentReaders = requireRole(Role.PATIENT, Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN, Role.RECEPTIONIST);
const portalScopes = Object.values(PortalAccessScope);
const registrationPassword = z.string().min(12).max(128).refine((value) => Buffer.byteLength(value, "utf8") <= 72);
const genericRegistrationMessage = "If the supplied details match an eligible patient, a verification code has been sent.";
const verificationExpiresMs = 10 * 60 * 1000;
const checkInTokenExpiresMs = 2 * 60 * 1000;

function portalError(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message } });
}

function hashChallengeCode(value: string) {
  return crypto.createHmac("sha256", env.SESSION_SECRET).update(value).digest("hex");
}

function safelyMatchesHash(value: string, expected: string) {
  const actualBytes = Buffer.from(hashChallengeCode(value), "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function auditData(req: AuthenticatedRequest, userId: string, input: Parameters<typeof auditLogData>[1]) {
  return { ...auditLogData(req, input), userId };
}

async function getAccessiblePatient(userId: string, patientId: string, scope: PortalAccessScope) {
  const patient = await prisma.patient.findFirst({ where: { id: patientId, portalUserId: userId } });
  if (patient) return { patient, delegated: false };
  const grant = await prisma.patientAccessGrant.findFirst({
    where: {
      patientId,
      granteeUserId: userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      scopes: { has: scope },
    },
    include: { patient: true },
  });
  return grant ? { patient: grant.patient, delegated: true } : null;
}

async function createPortalNotification(patientId: string, category: string, title: string, message: string) {
  const familyScopes = category === "APPOINTMENT"
    ? [PortalAccessScope.APPOINTMENTS]
    : [PortalAccessScope.APPOINTMENTS, PortalAccessScope.JOURNEY];
  const familyGrants = await prisma.patientAccessGrant.findMany({
    where: { patientId, revokedAt: null, expiresAt: { gt: new Date() }, scopes: { hasSome: familyScopes } },
    select: { granteeUserId: true, grantee: { select: { active: true } } },
  });
  const familyUserIds = [...new Set(familyGrants.filter((grant) => grant.grantee.active).map((grant) => grant.granteeUserId))];
  for (const userId of familyUserIds) {
    const preference = await prisma.portalNotificationPreference.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    if (preference.inAppEnabled) {
      await prisma.portalNotification.create({ data: { userId, category, title, message } });
    }
  }
  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    select: { portalUserId: true },
  });
  if (!patient?.portalUserId) return [];
  const user = await prisma.user.findUnique({
    where: { id: patient.portalUserId },
    select: { id: true, email: true, emailVerifiedAt: true },
  });
  if (!user) return [];
  const preferences = await prisma.portalNotificationPreference.upsert({
    where: { userId: user.id },
    create: { userId: user.id },
    update: { smsEnabled: false },
  });
  if (!preferences.inAppEnabled && !preferences.emailEnabled) return [];
  const notification = await prisma.portalNotification.create({ data: { userId: user.id, category, title, message } });
  const requested: Array<{ destination: string; body: string }> = [];
  if (preferences.emailEnabled && user.emailVerifiedAt) {
    requested.push({ destination: user.email, body: `${message}\nSign in to MediVerse to view details.` });
  }
  const results: Array<{ channel: NotificationChannel; status: NotificationDeliveryStatus }> = [];
  for (const delivery of requested) {
    const row = await prisma.notificationDelivery.create({
      data: { notificationId: notification.id, channel: NotificationChannel.EMAIL, destination: delivery.destination, attempts: 1 },
    });
    try {
      await sendPortalEmail(delivery.destination, title, delivery.body);
      await prisma.notificationDelivery.update({
        where: { id: row.id },
        data: { status: NotificationDeliveryStatus.SENT, sentAt: new Date() },
      });
      results.push({ channel: NotificationChannel.EMAIL, status: NotificationDeliveryStatus.SENT });
    } catch (error) {
      const lastError = error instanceof DeliveryUnavailableError ? error.message : "The configured delivery provider rejected the request.";
      await prisma.notificationDelivery.update({
        where: { id: row.id },
        data: { status: NotificationDeliveryStatus.FAILED, lastError: lastError.slice(0, 200) },
      });
      results.push({ channel: NotificationChannel.EMAIL, status: NotificationDeliveryStatus.FAILED });
    }
  }
  return results;
}

function addRegistrationChallengeResponse(res: Response, challengeId: string) {
  return res.status(202).json({ data: { challengeId, message: genericRegistrationMessage } });
}

portalRouter.post("/portal/register", async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      patientNumber: z.string().trim().min(1).max(40),
      dateOfBirth: z.string().date(),
      email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
      password: registrationPassword,
    }).parse(req.body);
    const challengeId = crypto.randomUUID();
    const ipAddress = getClientIp(req);
    const since = new Date(Date.now() - 15 * 60 * 1000);
    const recentAttempts = await prisma.portalVerificationChallenge.count({
      where: { ipAddress: ipAddress ?? undefined, purpose: PortalChallengePurpose.PATIENT_REGISTRATION, createdAt: { gte: since } },
    });
    if (recentAttempts >= 5) return addRegistrationChallengeResponse(res, challengeId);

    const startOfDay = new Date(`${input.dateOfBirth}T00:00:00.000Z`);
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
    const patient = await prisma.patient.findFirst({
      where: {
        patientNumber: input.patientNumber,
        dateOfBirth: { gte: startOfDay, lt: endOfDay },
        portalUserId: null,
      },
      select: { id: true },
    });
    const [existingEmail, patientAttempts] = await Promise.all([
      prisma.user.findUnique({ where: { email: input.email }, select: { id: true } }),
      patient ? prisma.portalVerificationChallenge.count({
        where: { patientId: patient.id, purpose: PortalChallengePurpose.PATIENT_REGISTRATION, createdAt: { gte: since } },
      }) : Promise.resolve(0),
    ]);
    if (!patient || existingEmail || patientAttempts >= 3) {
      return addRegistrationChallengeResponse(res, challengeId);
    }
    const code = String(crypto.randomInt(100_000, 1_000_000));
    const challenge = await prisma.portalVerificationChallenge.create({
      data: {
        id: challengeId,
        purpose: PortalChallengePurpose.PATIENT_REGISTRATION,
        patientId: patient.id,
        email: input.email,
        codeHash: hashChallengeCode(code),
        passwordHash: await bcrypt.hash(input.password, 12),
        ipAddress: ipAddress ?? undefined,
        expiresAt: new Date(Date.now() + verificationExpiresMs),
      },
    });
    try {
      await sendPortalEmail(input.email, "MediVerse patient portal verification", `Your MediVerse verification code is ${code}. It expires in 10 minutes.`);
    } catch (error) {
      await prisma.portalVerificationChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
      if (error instanceof DeliveryUnavailableError) {
        return portalError(res, 503, "VERIFICATION_DELIVERY_UNAVAILABLE", "Email verification is temporarily unavailable. Contact the hospital for assistance.");
      }
      return portalError(res, 503, "VERIFICATION_DELIVERY_FAILED", "Email verification could not be delivered. Please try again later.");
    }
    return addRegistrationChallengeResponse(res, challenge.id);
  } catch (error) {
    next(error);
  }
});

portalRouter.post("/portal/register/verify", async (req, res, next) => {
  try {
    const input = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const now = new Date();
    const challenge = await prisma.portalVerificationChallenge.findUnique({ where: { id: input.challengeId } });
    if (!challenge || challenge.purpose !== PortalChallengePurpose.PATIENT_REGISTRATION || challenge.consumedAt || challenge.expiresAt <= now || challenge.attempts >= 5 || !challenge.patientId || !challenge.email || !challenge.passwordHash) {
      return portalError(res, 400, "VERIFICATION_INVALID", "The verification code is invalid or expired.");
    }
    const attempt = await prisma.portalVerificationChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null, expiresAt: { gt: now }, attempts: { lt: 5 } },
      data: { attempts: { increment: 1 } },
    });
    if (attempt.count !== 1 || !safelyMatchesHash(input.code, challenge.codeHash)) {
      return portalError(res, 400, "VERIFICATION_INVALID", "The verification code is invalid or expired.");
    }
    const result = await prisma.$transaction(async (tx) => {
      const consumed = await tx.portalVerificationChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1) return null;
      const patient = await tx.patient.findFirst({ where: { id: challenge.patientId!, portalUserId: null } });
      if (!patient) return null;
      const user = await tx.user.create({
        data: {
          email: challenge.email!,
          name: `${patient.firstName} ${patient.lastName}`,
          passwordHash: challenge.passwordHash!,
          role: Role.PATIENT,
          emailVerifiedAt: new Date(),
        },
        select: { id: true, email: true, name: true, role: true },
      });
      await tx.patient.update({ where: { id: patient.id }, data: { portalUserId: user.id } });
      await tx.portalNotificationPreference.create({ data: { userId: user.id } });
      await tx.auditLog.create({ data: auditData(req as AuthenticatedRequest, user.id, { action: "REGISTER", entity: "PATIENT_PORTAL_ACCOUNT", entityId: patient.id }) });
      return user;
    });
    if (!result) return portalError(res, 409, "REGISTRATION_UNAVAILABLE", "The patient account could not be created. Contact the hospital for assistance.");
    res.status(201).json({ data: { user: result, emailVerificationRequired: false } });
  } catch (error) {
    next(error);
  }
});

portalRouter.post("/portal/email/verification", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { id: true, email: true, emailVerifiedAt: true } });
    if (!user) return portalError(res, 404, "ACCOUNT_NOT_FOUND", "The portal account was not found.");
    if (user.emailVerifiedAt) return res.json({ data: { verified: true } });
    const ipAddress = getClientIp(req);
    const recent = await prisma.portalVerificationChallenge.count({
      where: { userId: user.id, purpose: PortalChallengePurpose.EMAIL_VERIFICATION, createdAt: { gte: new Date(Date.now() - 15 * 60 * 1000) } },
    });
    if (recent >= 3) return portalError(res, 429, "VERIFICATION_RATE_LIMITED", "Please wait before requesting another verification code.");
    const code = String(crypto.randomInt(100_000, 1_000_000));
    const challenge = await prisma.portalVerificationChallenge.create({
      data: {
        purpose: PortalChallengePurpose.EMAIL_VERIFICATION,
        userId: user.id,
        email: user.email,
        codeHash: hashChallengeCode(code),
        ipAddress: ipAddress ?? undefined,
        expiresAt: new Date(Date.now() + verificationExpiresMs),
      },
    });
    try {
      await sendPortalEmail(user.email, "MediVerse email verification", `Your MediVerse verification code is ${code}. It expires in 10 minutes.`);
    } catch (error) {
      await prisma.portalVerificationChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
      if (error instanceof DeliveryUnavailableError) {
        return portalError(res, 503, "VERIFICATION_DELIVERY_UNAVAILABLE", "Email verification is temporarily unavailable. Try again later.");
      }
      return portalError(res, 503, "VERIFICATION_DELIVERY_FAILED", "Email verification could not be delivered. Please try again later.");
    }
    res.status(202).json({ data: { sent: true } });
  } catch (error) {
    next(error);
  }
});

portalRouter.post("/portal/email/verification/confirm", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const challenge = await prisma.portalVerificationChallenge.findFirst({
      where: {
        userId: req.auth!.userId,
        purpose: PortalChallengePurpose.EMAIL_VERIFICATION,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        attempts: { lt: 5 },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!challenge) return portalError(res, 400, "VERIFICATION_INVALID", "The verification code is invalid or expired.");
    const attempt = await prisma.portalVerificationChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null, expiresAt: { gt: new Date() }, attempts: { lt: 5 } },
      data: { attempts: { increment: 1 } },
    });
    if (attempt.count !== 1 || !safelyMatchesHash(input.code, challenge.codeHash)) {
      return portalError(res, 400, "VERIFICATION_INVALID", "The verification code is invalid or expired.");
    }
    const verified = await prisma.$transaction(async (tx) => {
      const used = await tx.portalVerificationChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (used.count !== 1) return null;
      const user = await tx.user.update({ where: { id: req.auth!.userId }, data: { emailVerifiedAt: new Date() }, select: { id: true } });
      await tx.auditLog.create({ data: auditData(req, user.id, { action: "VERIFY_EMAIL", entity: "PATIENT_PORTAL_ACCOUNT", entityId: user.id }) });
      return user;
    });
    if (!verified) return portalError(res, 409, "VERIFICATION_INVALID", "The verification code is invalid or expired.");
    res.json({ data: { verified: true } });
  } catch (error) {
    next(error);
  }
});

const familyInvitationInput = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  scopes: z.array(z.nativeEnum(PortalAccessScope)).min(1).max(portalScopes.length),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

portalRouter.get("/portal/family/access", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const patient = await prisma.patient.findUnique({ where: { portalUserId: req.auth!.userId }, select: { id: true } });
    if (!patient) return portalError(res, 403, "PATIENT_PROFILE_REQUIRED", "Only the linked patient can manage family access.");
    const [grants, invitations] = await Promise.all([
      prisma.patientAccessGrant.findMany({
        where: { patientId: patient.id },
        include: { grantee: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.familyAccessInvitation.findMany({
        where: { patientId: patient.id },
        select: { id: true, invitedEmail: true, scopes: true, expiresAt: true, acceptedAt: true, revokedAt: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    await prisma.auditLog.create({ data: auditData(req, req.auth!.userId, { action: "READ", entity: "PATIENT_ACCESS_GRANT", metadata: { grantCount: grants.length } }) });
    res.json({ data: { grants, invitations } });
  } catch (error) {
    next(error);
  }
});

portalRouter.post("/portal/family/invitations", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = familyInvitationInput.parse(req.body);
    const [patient, user] = await Promise.all([
      prisma.patient.findUnique({ where: { portalUserId: req.auth!.userId }, select: { id: true } }),
      prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { email: true } }),
    ]);
    if (!patient) return portalError(res, 403, "PATIENT_PROFILE_REQUIRED", "Only the linked patient can invite family members.");
    if (input.email === user?.email) return portalError(res, 400, "INVALID_INVITATION", "You cannot invite your own email address.");
    const token = crypto.randomBytes(32).toString("base64url");
    const invitation = await prisma.familyAccessInvitation.create({
      data: {
        patientId: patient.id,
        invitedById: req.auth!.userId,
        invitedEmail: input.email,
        tokenHash: hashToken(token),
        scopes: [...new Set(input.scopes)],
        expiresAt: new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000),
      },
      select: { id: true, invitedEmail: true, scopes: true, expiresAt: true },
    });
    try {
      await sendPortalEmail(
        input.email,
        "MediVerse family access invitation",
        `A patient invited you to access selected information in MediVerse. The invitation expires in ${input.expiresInDays} days. Open ${env.CLIENT_ORIGIN}/?familyInvite=${encodeURIComponent(token)} to accept.`,
      );
    } catch (error) {
      await prisma.familyAccessInvitation.update({ where: { id: invitation.id }, data: { revokedAt: new Date() } });
      if (error instanceof DeliveryUnavailableError) {
        return portalError(res, 503, "INVITATION_DELIVERY_UNAVAILABLE", "Family invitations cannot be sent until email delivery is configured.");
      }
      return portalError(res, 503, "INVITATION_DELIVERY_FAILED", "The invitation could not be delivered. Please try again later.");
    }
    await prisma.auditLog.create({ data: auditData(req, req.auth!.userId, { action: "INVITE", entity: "PATIENT_ACCESS_GRANT", entityId: invitation.id, metadata: { scopes: invitation.scopes, expiresAt: invitation.expiresAt } }) });
    res.status(201).json({ data: invitation });
  } catch (error) {
    next(error);
  }
});

portalRouter.get("/portal/family/invitations/preview", async (req, res, next) => {
  try {
    const input = z.object({ token: z.string().min(40).max(100) }).parse(req.query);
    const invitation = await prisma.familyAccessInvitation.findUnique({
      where: { tokenHash: hashToken(input.token) },
      select: { scopes: true, expiresAt: true, acceptedAt: true, revokedAt: true },
    });
    if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) {
      return portalError(res, 404, "INVITATION_NOT_FOUND", "The invitation is unavailable or expired.");
    }
    res.json({ data: { scopes: invitation.scopes, expiresAt: invitation.expiresAt } });
  } catch (error) {
    next(error);
  }
});

async function acceptFamilyInvitation(token: string, userId: string, email: string, res: Response, req: AuthenticatedRequest) {
  const invitation = await prisma.familyAccessInvitation.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!invitation || invitation.invitedEmail !== email || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) {
    return portalError(res, 400, "INVITATION_INVALID", "The family invitation is invalid or expired.");
  }
  return prisma.$transaction(async (tx) => {
    const accepted = await tx.familyAccessInvitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { acceptedAt: new Date(), acceptedById: userId },
    });
    if (accepted.count !== 1) return portalError(res, 409, "INVITATION_INVALID", "The family invitation is invalid or expired.");
    const grant = await tx.patientAccessGrant.create({
      data: {
        patientId: invitation.patientId,
        granteeUserId: userId,
        grantedByUserId: invitation.invitedById,
        scopes: invitation.scopes,
        expiresAt: invitation.expiresAt,
      },
      select: { id: true, patientId: true, scopes: true, expiresAt: true },
    });
    await tx.auditLog.create({ data: auditData(req, userId, { action: "ACCEPT_INVITATION", entity: "PATIENT_ACCESS_GRANT", entityId: grant.id, metadata: { patientId: grant.patientId, scopes: grant.scopes } }) });
    return res.status(201).json({ data: { grant } });
  });
}

portalRouter.post("/portal/family/invitations/accept", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ token: z.string().min(40).max(100) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { email: true, emailVerifiedAt: true } });
    if (!user?.emailVerifiedAt) return portalError(res, 403, "VERIFIED_EMAIL_REQUIRED", "Verify your email address before accepting a family invitation.");
    await acceptFamilyInvitation(input.token, req.auth!.userId, user.email, res, req);
  } catch (error) {
    next(error);
  }
});

portalRouter.post("/portal/family/invitations/register", async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      token: z.string().min(40).max(100),
      name: z.string().trim().min(1).max(120),
      password: registrationPassword,
    }).parse(req.body);
    const invitation = await prisma.familyAccessInvitation.findUnique({ where: { tokenHash: hashToken(input.token) } });
    if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) {
      return portalError(res, 400, "INVITATION_INVALID", "The family invitation is invalid or expired.");
    }
    if (await prisma.user.findUnique({ where: { email: invitation.invitedEmail }, select: { id: true } })) {
      return portalError(res, 409, "ACCOUNT_EXISTS", "Sign in to the invited MediVerse account, verify its email, and accept the invitation.");
    }
    const result = await prisma.$transaction(async (tx) => {
      const accepted = await tx.familyAccessInvitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { acceptedAt: new Date() },
      });
      if (accepted.count !== 1) return null;
      const user = await tx.user.create({
        data: { email: invitation.invitedEmail, name: input.name, passwordHash: await bcrypt.hash(input.password, 12), role: Role.PATIENT, emailVerifiedAt: new Date() },
        select: { id: true, email: true, name: true, role: true },
      });
      await tx.familyAccessInvitation.update({ where: { id: invitation.id }, data: { acceptedById: user.id } });
      const grant = await tx.patientAccessGrant.create({
        data: {
          patientId: invitation.patientId,
          granteeUserId: user.id,
          grantedByUserId: invitation.invitedById,
          scopes: invitation.scopes,
          expiresAt: invitation.expiresAt,
        },
        select: { id: true, patientId: true, scopes: true, expiresAt: true },
      });
      await tx.portalNotificationPreference.create({ data: { userId: user.id } });
      await tx.auditLog.create({ data: auditData(req, user.id, { action: "ACCEPT_INVITATION", entity: "PATIENT_ACCESS_GRANT", entityId: grant.id, metadata: { patientId: grant.patientId, scopes: grant.scopes } }) });
      return { user, grant };
    });
    if (!result) return portalError(res, 409, "INVITATION_INVALID", "The family invitation is invalid or expired.");
    res.status(201).json({ data: result });
  } catch (error) {
    next(error);
  }
});

portalRouter.patch("/portal/family/grants/:id/revoke", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const patient = await prisma.patient.findUnique({ where: { portalUserId: req.auth!.userId }, select: { id: true } });
    if (!patient) return portalError(res, 403, "PATIENT_PROFILE_REQUIRED", "Only the linked patient can revoke family access.");
    const changed = await prisma.patientAccessGrant.updateMany({
      where: { id: String(req.params.id), patientId: patient.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (changed.count !== 1) return portalError(res, 404, "ACCESS_GRANT_NOT_FOUND", "The active family grant was not found.");
    await prisma.auditLog.create({ data: auditData(req, req.auth!.userId, { action: "REVOKE", entity: "PATIENT_ACCESS_GRANT", entityId: String(req.params.id) }) });
    res.json({ data: { revoked: true } });
  } catch (error) {
    next(error);
  }
});

portalRouter.patch("/portal/family/invitations/:id/revoke", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const patient = await prisma.patient.findUnique({ where: { portalUserId: req.auth!.userId }, select: { id: true } });
    if (!patient) return portalError(res, 403, "PATIENT_PROFILE_REQUIRED", "Only the linked patient can revoke family invitations.");
    const changed = await prisma.familyAccessInvitation.updateMany({
      where: { id: String(req.params.id), patientId: patient.id, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (changed.count !== 1) return portalError(res, 404, "INVITATION_NOT_FOUND", "The active family invitation was not found.");
    await prisma.auditLog.create({ data: auditData(req, req.auth!.userId, { action: "REVOKE_INVITATION", entity: "PATIENT_ACCESS_GRANT", entityId: String(req.params.id) }) });
    res.json({ data: { revoked: true } });
  } catch (error) {
    next(error);
  }
});

portalRouter.get("/portal/family/grants", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const grants = await prisma.patientAccessGrant.findMany({
      where: { granteeUserId: req.auth!.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      include: { patient: { select: { id: true, patientNumber: true, firstName: true, lastName: true } } },
      orderBy: { expiresAt: "asc" },
    });
    await prisma.auditLog.create({ data: auditData(req, req.auth!.userId, { action: "READ", entity: "PATIENT_ACCESS_GRANT", metadata: { grantCount: grants.length } }) });
    res.json({ data: grants });
  } catch (error) {
    next(error);
  }
});

portalRouter.get("/portal/patients", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const [self, grants] = await Promise.all([
      prisma.patient.findUnique({
        where: { portalUserId: req.auth!.userId },
        select: { id: true, patientNumber: true, firstName: true, lastName: true },
      }),
      prisma.patientAccessGrant.findMany({
        where: { granteeUserId: req.auth!.userId, revokedAt: null, expiresAt: { gt: new Date() } },
        include: { patient: { select: { id: true, patientNumber: true, firstName: true, lastName: true } } },
        orderBy: { expiresAt: "asc" },
      }),
    ]);
    const entries = [
      ...(self ? [{ patient: self, scopes: portalScopes, expiresAt: null, isSelf: true }] : []),
      ...grants.map((grant) => ({ patient: grant.patient, scopes: grant.scopes, expiresAt: grant.expiresAt, isSelf: false })),
    ];
    await prisma.auditLog.create({ data: auditData(req, req.auth!.userId, { action: "READ", entity: "PORTAL_PATIENT_ACCESS", metadata: { patientCount: entries.length } }) });
    res.json({ data: entries });
  } catch (error) {
    next(error);
  }
});

portalRouter.get("/portal/account", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const account = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: { email: true, emailVerifiedAt: true, patientProfile: { select: { id: true } } },
    });
    if (!account) return portalError(res, 404, "ACCOUNT_NOT_FOUND", "The portal account was not found.");
    res.json({ data: { email: account.email, emailVerified: Boolean(account.emailVerifiedAt), hasPatientProfile: Boolean(account.patientProfile) } });
  } catch (error) {
    next(error);
  }
});

portalRouter.get("/portal/departments", requireAuth, departmentReaders, async (_req, res, next) => {
  try {
    const departments = await prisma.department.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
    res.json({ data: departments });
  } catch (error) {
    next(error);
  }
});

portalRouter.get("/portal/doctors", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const query = z.object({ patientId: z.string().min(1) }).parse(req.query);
    const access = await getAccessiblePatient(req.auth!.userId, query.patientId, PortalAccessScope.APPOINTMENTS);
    if (!access) return portalError(res, 404, "PATIENT_NOT_FOUND", "The patient is unavailable for appointment access.");
    const doctors = await prisma.doctor.findMany({
      where: { onDuty: true, user: { active: true } },
      select: { id: true, specialty: true, user: { select: { name: true } }, department: { select: { id: true, name: true } } },
      orderBy: [{ department: { name: "asc" } }, { user: { name: "asc" } }],
    });
    res.json({ data: doctors });
  } catch (error) {
    next(error);
  }
});

portalRouter.get("/portal/appointments", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const query = z.object({ patientId: z.string().min(1) }).parse(req.query);
    const access = await getAccessiblePatient(req.auth!.userId, query.patientId, PortalAccessScope.APPOINTMENTS);
    if (!access) return portalError(res, 404, "PATIENT_NOT_FOUND", "The patient is unavailable for appointment access.");
    const appointments = await prisma.appointment.findMany({
      where: { patientId: access.patient.id },
      select: {
        id: true, startsAt: true, endsAt: true, status: true,
        doctor: { select: { id: true, specialty: true, user: { select: { name: true } } } },
        department: { select: { id: true, name: true } },
        queueEntry: { select: { id: true, sequence: true, status: true, serviceDate: true } },
      },
      orderBy: { startsAt: "asc" },
      take: 100,
    });
    await prisma.auditLog.create({ data: auditData(req, req.auth!.userId, { action: "READ", entity: "PORTAL_APPOINTMENT", metadata: { patientId: access.patient.id, delegated: access.delegated, count: appointments.length } }) });
    res.json({ data: appointments });
  } catch (error) {
    next(error);
  }
});

const appointmentBookingInput = z.object({
  patientId: z.string().min(1),
  doctorId: z.string().min(1),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
});

portalRouter.post("/portal/appointments", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = appointmentBookingInput.parse(req.body);
    const start = new Date(input.startsAt);
    const end = new Date(input.endsAt);
    const now = new Date();
    if (start <= now || end <= start || end.getTime() - start.getTime() > 4 * 60 * 60 * 1000) {
      return portalError(res, 400, "INVALID_APPOINTMENT_TIME", "Choose a future start and end time no more than four hours apart.");
    }
    const access = await getAccessiblePatient(req.auth!.userId, input.patientId, PortalAccessScope.APPOINTMENTS);
    if (!access) return portalError(res, 404, "PATIENT_NOT_FOUND", "The patient is unavailable for appointment access.");
    const booking = await prisma.$transaction(async (tx) => {
      const doctor = await tx.doctor.findFirst({
        where: { id: input.doctorId, onDuty: true, user: { active: true } },
        select: { id: true, departmentId: true },
      });
      if (!doctor) return { kind: "unavailable" as const };
      const conflict = await tx.appointment.findFirst({
        where: {
          OR: [{ doctorId: doctor.id }, { patientId: access.patient.id }],
          status: { in: [AppointmentStatus.SCHEDULED, AppointmentStatus.CONFIRMED] },
          startsAt: { lt: end },
          endsAt: { gt: start },
        },
        select: { id: true },
      });
      if (conflict) return { kind: "conflict" as const };
      const created = await tx.appointment.create({
        data: { patientId: access.patient.id, doctorId: doctor.id, departmentId: doctor.departmentId, startsAt: start, endsAt: end },
        select: { id: true, startsAt: true, endsAt: true, status: true },
      });
      await tx.auditLog.create({ data: auditData(req, req.auth!.userId, { action: "BOOK", entity: "PORTAL_APPOINTMENT", entityId: created.id, metadata: { patientId: access.patient.id, delegated: access.delegated } }) });
      return { kind: "booked" as const, appointment: created };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (booking.kind === "unavailable") return portalError(res, 404, "DOCTOR_NOT_AVAILABLE", "The selected clinician is not currently on duty.");
    if (booking.kind === "conflict") return portalError(res, 409, "APPOINTMENT_TIME_UNAVAILABLE", "The patient or clinician already has an appointment at the selected time.");
    const notifications = await createPortalNotification(access.patient.id, "APPOINTMENT", "Appointment scheduled", "An appointment has been scheduled in your MediVerse portal.");
    res.status(201).json({ data: { appointment: booking.appointment, notificationDelivery: notifications } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return portalError(res, 409, "APPOINTMENT_TIME_UNAVAILABLE", "The patient or clinician already has an appointment at the selected time.");
    }
    next(error);
  }
});

portalRouter.patch("/portal/appointments/:id/cancel", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ patientId: z.string().min(1) }).parse(req.body);
    const access = await getAccessiblePatient(req.auth!.userId, input.patientId, PortalAccessScope.APPOINTMENTS);
    if (!access) return portalError(res, 404, "APPOINTMENT_NOT_FOUND", "The appointment was not found.");
    const changed = await prisma.appointment.updateMany({
      where: {
        id: String(req.params.id),
        patientId: access.patient.id,
        status: { in: [AppointmentStatus.SCHEDULED, AppointmentStatus.CONFIRMED] },
        startsAt: { gt: new Date() },
      },
      data: { status: AppointmentStatus.CANCELLED },
    });
    if (changed.count !== 1) return portalError(res, 404, "APPOINTMENT_NOT_FOUND", "The appointment was not found or can no longer be cancelled.");
    await prisma.auditLog.create({ data: auditData(req, req.auth!.userId, { action: "CANCEL", entity: "PORTAL_APPOINTMENT", entityId: String(req.params.id), metadata: { patientId: access.patient.id, delegated: access.delegated } }) });
    const notifications = await createPortalNotification(access.patient.id, "APPOINTMENT", "Appointment updated", "An appointment has been cancelled in your MediVerse portal.");
    res.json({ data: { cancelled: true, notificationDelivery: notifications } });
  } catch (error) {
    next(error);
  }
});

portalRouter.get("/portal/journey", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const query = z.object({ patientId: z.string().min(1) }).parse(req.query);
    const access = await getAccessiblePatient(req.auth!.userId, query.patientId, PortalAccessScope.JOURNEY);
    if (!access) return portalError(res, 404, "PATIENT_NOT_FOUND", "The patient is unavailable for journey access.");
    const [appointments, admissions, queueEntries] = await Promise.all([
      prisma.appointment.findMany({ where: { patientId: access.patient.id }, select: { id: true, startsAt: true, status: true, doctor: { select: { user: { select: { name: true } } } }, department: { select: { name: true } } }, take: 100 }),
      prisma.admission.findMany({ where: { patientId: access.patient.id }, select: { id: true, admittedAt: true, dischargedAt: true, status: true }, take: 100 }),
      prisma.queueEntry.findMany({ where: { patientId: access.patient.id }, select: { id: true, checkedInAt: true, sequence: true, status: true, department: { select: { name: true } } }, take: 100 }),
    ]);
    const events = [
      ...appointments.map((item) => ({ id: item.id, occurredAt: item.startsAt, type: "APPOINTMENT", label: `Appointment · ${item.doctor.user.name} · ${item.department.name}`, status: item.status })),
      ...admissions.map((item) => ({ id: item.id, occurredAt: item.admittedAt, type: "ADMISSION", label: "Hospital admission", status: item.status })),
      ...queueEntries.map((item) => ({ id: item.id, occurredAt: item.checkedInAt, type: "QUEUE", label: `${item.department.name} queue · token ${item.sequence}`, status: item.status })),
    ].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    await prisma.auditLog.create({ data: auditData(req, req.auth!.userId, { action: "READ", entity: "PATIENT_JOURNEY", metadata: { patientId: access.patient.id, delegated: access.delegated, eventCount: events.length } }) });
    res.json({ data: events });
  } catch (error) {
    next(error);
  }
});

portalRouter.get("/portal/lab-results", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const query = z.object({ patientId: z.string().min(1) }).parse(req.query);
    const access = await getAccessiblePatient(req.auth!.userId, query.patientId, PortalAccessScope.LAB_RESULTS);
    if (!access) return portalError(res, 404, "PATIENT_NOT_FOUND", "The patient is unavailable for laboratory result access.");
    const orders = await prisma.labOrder.findMany({
      where: { patientId: access.patient.id, status: "COMPLETED" },
      select: { id: true, testName: true, status: true, updatedAt: true, result: { select: { summary: true, createdAt: true } } },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    await prisma.auditLog.create({ data: auditData(req, req.auth!.userId, { action: "READ", entity: "PORTAL_LAB_RESULT", metadata: { patientId: access.patient.id, delegated: access.delegated, count: orders.length } }) });
    res.json({ data: orders });
  } catch (error) {
    next(error);
  }
});

portalRouter.get("/portal/billing", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const query = z.object({ patientId: z.string().min(1) }).parse(req.query);
    const access = await getAccessiblePatient(req.auth!.userId, query.patientId, PortalAccessScope.BILLING);
    if (!access) return portalError(res, 404, "PATIENT_NOT_FOUND", "The patient is unavailable for billing access.");
    const invoices = await prisma.invoice.findMany({
      where: { patientId: access.patient.id },
      select: { id: true, total: true, balance: true, status: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    await prisma.auditLog.create({ data: auditData(req, req.auth!.userId, { action: "READ", entity: "PORTAL_BILLING", metadata: { patientId: access.patient.id, delegated: access.delegated, count: invoices.length } }) });
    res.json({ data: invoices });
  } catch (error) {
    next(error);
  }
});

portalRouter.post("/portal/appointments/:id/check-in-token", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ patientId: z.string().min(1) }).parse(req.body);
    const access = await getAccessiblePatient(req.auth!.userId, input.patientId, PortalAccessScope.APPOINTMENTS);
    if (!access) return portalError(res, 404, "APPOINTMENT_NOT_FOUND", "The appointment was not found.");
    const appointment = await prisma.appointment.findFirst({
      where: {
        id: String(req.params.id),
        patientId: access.patient.id,
        status: { in: [AppointmentStatus.SCHEDULED, AppointmentStatus.CONFIRMED] },
      },
      select: { id: true, startsAt: true, endsAt: true, queueEntry: { select: { id: true } } },
    });
    const now = new Date();
    if (!appointment || appointment.queueEntry || now < new Date(appointment.startsAt.getTime() - 24 * 60 * 60 * 1000) || now >= appointment.endsAt) {
      return portalError(res, 409, "CHECK_IN_UNAVAILABLE", "This appointment is not eligible for check-in.");
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + checkInTokenExpiresMs);
    const issued = await prisma.$transaction(async (tx) => {
      await tx.appointmentCheckInToken.updateMany({
        where: { appointmentId: appointment.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      const created = await tx.appointmentCheckInToken.create({
        data: { appointmentId: appointment.id, issuedByUserId: req.auth!.userId, tokenHash: hashToken(token), expiresAt },
        select: { id: true, expiresAt: true },
      });
      await tx.auditLog.create({ data: auditData(req, req.auth!.userId, { action: "ISSUE_CHECK_IN_TOKEN", entity: "APPOINTMENT", entityId: appointment.id, metadata: { delegated: access.delegated } }) });
      return created;
    });
    res.status(201).json({ data: { token, expiresAt: issued.expiresAt } });
  } catch (error) {
    next(error);
  }
});

function utcServiceDate(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

portalRouter.post("/portal/check-in/redeem", requireAuth, administratorOrReceptionist, async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ token: z.string().min(40).max(100) }).parse(req.body);
    const now = new Date();
    const issued = await prisma.appointmentCheckInToken.findUnique({
      where: { tokenHash: hashToken(input.token) },
      include: {
        appointment: {
          include: {
            patient: { select: { id: true, patientNumber: true, firstName: true, lastName: true } },
            department: { select: { id: true, name: true } },
            queueEntry: { select: { id: true } },
          },
        },
      },
    });
    if (!issued || issued.consumedAt || issued.expiresAt <= now || issued.appointment.queueEntry || !([AppointmentStatus.SCHEDULED, AppointmentStatus.CONFIRMED] as AppointmentStatus[]).includes(issued.appointment.status) || now < new Date(issued.appointment.startsAt.getTime() - 24 * 60 * 60 * 1000) || now >= issued.appointment.endsAt) {
      return portalError(res, 400, "CHECK_IN_TOKEN_INVALID", "The check-in QR token is invalid, expired, or already used.");
    }
    const serviceDate = utcServiceDate(now);
    const entry = await prisma.$transaction(async (tx) => {
      const consumed = await tx.appointmentCheckInToken.updateMany({
        where: { id: issued.id, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1) return null;
      const counter = await tx.queueCounter.upsert({
        where: { departmentId_serviceDate: { departmentId: issued.appointment.departmentId, serviceDate } },
        create: { departmentId: issued.appointment.departmentId, serviceDate, lastNumber: 1 },
        update: { lastNumber: { increment: 1 } },
        select: { lastNumber: true },
      });
      const created = await tx.queueEntry.create({
        data: {
          patientId: issued.appointment.patientId,
          appointmentId: issued.appointmentId,
          departmentId: issued.appointment.departmentId,
          serviceDate,
          sequence: counter.lastNumber,
        },
        select: { id: true, sequence: true, status: true, checkedInAt: true },
      });
      await tx.auditLog.create({ data: auditData(req, req.auth!.userId, { action: "CHECK_IN", entity: "QUEUE_ENTRY", entityId: created.id, metadata: { appointmentId: issued.appointmentId, patientId: issued.appointment.patientId } }) });
      return created;
    });
    if (!entry) return portalError(res, 409, "CHECK_IN_TOKEN_INVALID", "The check-in QR token has already been used.");
    const notifications = await createPortalNotification(issued.appointment.patientId, "QUEUE", "Check-in complete", "Your check-in is complete. Sign in to view your queue status.");
    res.status(201).json({ data: { entry, patient: issued.appointment.patient, department: issued.appointment.department, notificationDelivery: notifications } });
  } catch (error) {
    next(error);
  }
});

portalRouter.get("/portal/queue", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const query = z.object({ patientId: z.string().min(1) }).parse(req.query);
    const access = await getAccessiblePatient(req.auth!.userId, query.patientId, PortalAccessScope.APPOINTMENTS);
    if (!access) return portalError(res, 404, "PATIENT_NOT_FOUND", "The patient is unavailable for queue access.");
    const entries = await prisma.queueEntry.findMany({
      where: { patientId: access.patient.id },
      select: { id: true, sequence: true, serviceDate: true, checkedInAt: true, status: true, department: { select: { name: true } }, appointment: { select: { startsAt: true, doctor: { select: { user: { select: { name: true } } } } } } },
      orderBy: { checkedInAt: "desc" },
      take: 30,
    });
    await prisma.auditLog.create({ data: auditData(req, req.auth!.userId, { action: "READ", entity: "PORTAL_QUEUE", metadata: { patientId: access.patient.id, delegated: access.delegated, count: entries.length } }) });
    res.json({ data: entries });
  } catch (error) {
    next(error);
  }
});

portalRouter.get("/portal/queue/desk", requireAuth, administratorOrReceptionist, async (req, res, next) => {
  try {
    const query = z.object({ departmentId: z.string().min(1) }).parse(req.query);
    const entries = await prisma.queueEntry.findMany({
      where: { departmentId: query.departmentId, serviceDate: utcServiceDate(new Date()), status: { not: QueueEntryStatus.CANCELLED } },
      include: { patient: { select: { patientNumber: true, firstName: true, lastName: true } }, appointment: { select: { startsAt: true, doctor: { select: { user: { select: { name: true } } } } } } },
      orderBy: { sequence: "asc" },
      take: 200,
    });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "QUEUE_DESK", metadata: { departmentId: query.departmentId, count: entries.length } }) });
    res.json({ data: entries });
  } catch (error) {
    next(error);
  }
});

portalRouter.patch("/portal/queue/desk/:id", requireAuth, administratorOrReceptionist, async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ status: z.nativeEnum(QueueEntryStatus) }).parse(req.body);
    const current = await prisma.queueEntry.findUnique({ where: { id: String(req.params.id) }, select: { id: true, patientId: true, status: true } });
    if (!current) return portalError(res, 404, "QUEUE_ENTRY_NOT_FOUND", "The queue entry was not found.");
    const allowed: QueueEntryStatus[] = current.status === QueueEntryStatus.WAITING
      ? [QueueEntryStatus.CALLED, QueueEntryStatus.CANCELLED]
      : current.status === QueueEntryStatus.CALLED
        ? [QueueEntryStatus.IN_PROGRESS, QueueEntryStatus.CANCELLED]
        : current.status === QueueEntryStatus.IN_PROGRESS
          ? [QueueEntryStatus.COMPLETED, QueueEntryStatus.CANCELLED]
          : [];
    if (!allowed.includes(input.status)) return portalError(res, 409, "INVALID_QUEUE_TRANSITION", "The requested queue status transition is not allowed.");
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.queueEntry.updateMany({ where: { id: current.id, status: current.status }, data: { status: input.status } });
      if (changed.count !== 1) return null;
      const entry = await tx.queueEntry.findUniqueOrThrow({ where: { id: current.id }, select: { id: true, sequence: true, status: true, patientId: true } });
      await tx.auditLog.create({ data: auditData(req, req.auth!.userId, { action: "UPDATE_STATUS", entity: "QUEUE_ENTRY", entityId: entry.id, metadata: { status: entry.status } }) });
      return entry;
    });
    if (!updated) return portalError(res, 409, "QUEUE_ENTRY_CHANGED", "The queue entry changed before this update was applied.");
    const notifications = await createPortalNotification(updated.patientId, "QUEUE", "Queue status updated", "Your queue status has changed. Sign in to view details.");
    res.json({ data: { entry: updated, notificationDelivery: notifications } });
  } catch (error) {
    next(error);
  }
});

portalRouter.get("/portal/notifications", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const [items, preference] = await Promise.all([
      prisma.portalNotification.findMany({
        where: { userId: req.auth!.userId },
        select: { id: true, category: true, title: true, message: true, readAt: true, createdAt: true, deliveries: { where: { channel: NotificationChannel.EMAIL }, select: { channel: true, status: true, attempts: true, lastError: true, sentAt: true } } },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      prisma.portalNotificationPreference.findUnique({ where: { userId: req.auth!.userId } }),
    ]);
    res.json({ data: { items: preference?.inAppEnabled ? items : [], preference } });
  } catch (error) {
    next(error);
  }
});

portalRouter.patch("/portal/notifications/:id/read", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const changed = await prisma.portalNotification.updateMany({
      where: { id: String(req.params.id), userId: req.auth!.userId, readAt: null },
      data: { readAt: new Date() },
    });
    if (!changed.count) return portalError(res, 404, "NOTIFICATION_NOT_FOUND", "The notification was not found.");
    res.json({ data: { read: true } });
  } catch (error) {
    next(error);
  }
});

portalRouter.post("/portal/notifications/:id/retry", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const notification = await prisma.portalNotification.findFirst({
      where: { id: String(req.params.id), userId: req.auth!.userId },
      include: { deliveries: { where: { channel: NotificationChannel.EMAIL, status: NotificationDeliveryStatus.FAILED, attempts: { lt: 3 } } } },
    });
    if (!notification) return portalError(res, 404, "NOTIFICATION_NOT_FOUND", "The notification was not found.");
    const [user, preference] = await Promise.all([
      prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { emailVerifiedAt: true } }),
      prisma.portalNotificationPreference.findUnique({ where: { userId: req.auth!.userId } }),
    ]);
    if (!user || !preference) return portalError(res, 404, "NOTIFICATION_PREFERENCE_NOT_FOUND", "Notification preferences were not found.");
    const outcomes: Array<{ channel: NotificationChannel; status: NotificationDeliveryStatus }> = [];
    for (const delivery of notification.deliveries) {
      const enabled = preference.emailEnabled && Boolean(user.emailVerifiedAt);
      if (!enabled) continue;
      const claimed = await prisma.notificationDelivery.updateMany({
        where: { id: delivery.id, status: NotificationDeliveryStatus.FAILED, attempts: { lt: 3 } },
        data: { status: NotificationDeliveryStatus.PENDING, attempts: { increment: 1 }, lastError: null },
      });
      if (claimed.count !== 1) continue;
      try {
        await sendPortalEmail(delivery.destination, notification.title, `${notification.message}\nSign in to MediVerse to view details.`);
        await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { status: NotificationDeliveryStatus.SENT, sentAt: new Date() } });
        outcomes.push({ channel: delivery.channel, status: NotificationDeliveryStatus.SENT });
      } catch (error) {
        const lastError = error instanceof DeliveryUnavailableError ? error.message : "The configured delivery provider rejected the request.";
        await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { status: NotificationDeliveryStatus.FAILED, lastError: lastError.slice(0, 200) } });
        outcomes.push({ channel: delivery.channel, status: NotificationDeliveryStatus.FAILED });
      }
    }
    await prisma.auditLog.create({ data: auditData(req, req.auth!.userId, { action: "RETRY_DELIVERY", entity: "PORTAL_NOTIFICATION", entityId: notification.id, metadata: { retriedChannels: outcomes.map((item) => item.channel) } }) });
    res.json({ data: { deliveries: outcomes } });
  } catch (error) {
    next(error);
  }
});

portalRouter.patch("/portal/notification-preferences", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ inAppEnabled: z.boolean(), emailEnabled: z.boolean() }).parse(req.body);
    const user = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: { emailVerifiedAt: true, patientProfile: { select: { id: true } } },
    });
    if (!user) return portalError(res, 404, "ACCOUNT_NOT_FOUND", "The portal account was not found.");
    if (!user.patientProfile && input.emailEnabled) {
      return portalError(res, 400, "DELEGATE_DELIVERY_UNAVAILABLE", "Family accounts can enable in-app notifications only.");
    }
    if (input.emailEnabled && !user.emailVerifiedAt) return portalError(res, 400, "VERIFIED_EMAIL_REQUIRED", "Verify your email address before enabling email notifications.");
    const preference = await prisma.portalNotificationPreference.upsert({
      where: { userId: req.auth!.userId },
      create: { userId: req.auth!.userId, ...input, smsEnabled: false },
      update: { ...input, smsEnabled: false },
    });
    await prisma.auditLog.create({ data: auditData(req, req.auth!.userId, { action: "UPDATE_PREFERENCES", entity: "PORTAL_NOTIFICATION_PREFERENCE", entityId: preference.id }) });
    res.json({ data: preference });
  } catch (error) {
    next(error);
  }
});

portalRouter.get("/portal/notification-preferences", requireAuth, portalRole, async (req: AuthenticatedRequest, res, next) => {
  try {
    const preference = await prisma.portalNotificationPreference.upsert({
      where: { userId: req.auth!.userId },
      create: { userId: req.auth!.userId },
      update: { smsEnabled: false },
    });
    res.json({ data: preference });
  } catch (error) {
    next(error);
  }
});
