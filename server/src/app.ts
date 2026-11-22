import express from "express";
import helmet from "helmet";
import cors from "cors";
import { AppointmentStatus, AdmissionStatus, LabStatus, InvoiceStatus, Prisma, Role } from "@prisma/client";
import { z } from "zod";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { env } from "./config/env.js";
import { prisma } from "./db.js";
import {
  SESSION_MAX_AGE_MS,
  auditLogData,
  clearSessionCookie,
  checkLoginRateLimit,
  getSessionToken,
  getClientIp,
  hashToken,
  requireAuth,
  requireMfaChallenge,
  requireRole,
  requireSafeOrigin,
  setSessionCookie,
  writeAudit,
  type AuthenticatedRequest,
} from "./auth.js";
import {
  createTotpUri,
  decryptMfaSecret,
  encryptMfaSecret,
  generateMfaSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyTotp,
} from "./mfa.js";
import { clinicalRouter } from "./clinical.js";
import { portalRouter } from "./portal.js";

export const app = express();
app.use(helmet());
app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(requireSafeOrigin);
app.get("/api/v1/health", (_req, res) => res.json({ data: { status: "ok", syntheticData: env.NODE_ENV !== "production" } }));
const passwordSchema = z.string().min(12).max(128).refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password must not exceed 72 UTF-8 bytes.");
const currentPasswordSchema = z.string().min(8).max(128).refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password is too long.");
const dummyPasswordHash = bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
class InvalidMfaVerificationError extends Error {}

const administratorRoles = [Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN] as const;
const patientReadRoles = [Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTIONIST] as const;
const appointmentRoles = [Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN, Role.DOCTOR, Role.RECEPTIONIST] as const;
const admissionRoles = [Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN, Role.DOCTOR, Role.NURSE] as const;
const labRoles = [Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.LAB_TECHNICIAN, Role.RADIOLOGIST] as const;
const billingRoles = [Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN, Role.BILLING_STAFF, Role.ACCOUNTANT] as const;

function canAssignRole(actor: Role, requested: Role) {
  if (actor === Role.SUPER_ADMIN) return true;
  if (actor === Role.HOSPITAL_ADMIN) return requested !== Role.SUPER_ADMIN;
  if (actor === Role.ADMIN) return !administratorRoles.includes(requested as (typeof administratorRoles)[number]);
  return false;
}

async function recordAuthenticationFailure(
  req: express.Request,
  input: { email: string; userId?: string; reason: string; action: string; entity?: string },
) {
  await prisma.$transaction(async (tx) => {
    await tx.loginHistory.create({
      data: { email: input.email, userId: input.userId, successful: false, failureReason: input.reason, ipAddress: getClientIp(req), userAgent: req.header("user-agent")?.slice(0, 500) },
    });
    await tx.auditLog.create({
      data: auditLogData(req, { action: input.action, entity: input.entity ?? "AUTHENTICATION", success: false }),
    });
  });
}

app.post("/api/v1/auth/login", async (req, res, next) => {
  try {
    const input = z.object({
      email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
      password: z.string().min(8).max(128).refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password is too long."),
    }).parse(req.body);
    const ipAddress = getClientIp(req);

    if (await checkLoginRateLimit(input.email, ipAddress)) {
      await recordAuthenticationFailure(req, { email: input.email, reason: "RATE_LIMITED", action: "LOGIN_RATE_LIMITED" });
      return res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many login attempts. Try again later." } });
    }

    const user = await prisma.user.findUnique({ where: { email: input.email } });
    const passwordMatches = await bcrypt.compare(input.password, user?.passwordHash ?? await dummyPasswordHash);
    if (!user?.active || !passwordMatches) {
      await recordAuthenticationFailure(req, { userId: user?.id, email: input.email, reason: "INVALID_CREDENTIALS", action: "LOGIN_FAILED" });
      return res.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "The email or password is incorrect." } });
    }

    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
    (req as AuthenticatedRequest).auth = { userId: user.id, role: user.role };
    await prisma.$transaction(async (tx) => {
      await tx.session.create({
        data: { userId: user.id, tokenHash: hashToken(token), expiresAt, mfaVerified: !user.mfaEnabled, ipAddress, userAgent: req.header("user-agent")?.slice(0, 500) },
      });
      await tx.loginHistory.create({
        data: { userId: user.id, email: user.email, successful: !user.mfaEnabled, failureReason: user.mfaEnabled ? "MFA_PENDING" : null, ipAddress, userAgent: req.header("user-agent")?.slice(0, 500) },
      });
      await tx.auditLog.create({
        data: auditLogData(req, { action: user.mfaEnabled ? "MFA_CHALLENGE_STARTED" : "LOGIN", entity: "SESSION", success: true }),
      });
    });
    setSessionCookie(res, token, expiresAt);
    res.setHeader("Cache-Control", "no-store");
    res.json({ data: { mfaRequired: user.mfaEnabled, user: { id: user.id, name: user.name, email: user.email, role: user.role, mfaEnabled: user.mfaEnabled } } });
  } catch (error) { next(error); }
});
app.post("/api/v1/auth/logout", async (req: AuthenticatedRequest, res, next) => {
  try {
    const token = getSessionToken(req);
    if (token) {
      const session = await prisma.session.findUnique({
        where: { tokenHash: hashToken(token) },
        select: { id: true, userId: true, user: { select: { role: true } } },
      });
      if (session) {
        req.auth = { userId: session.userId, role: session.user.role };
        await prisma.$transaction(async (tx) => {
          const result = await tx.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { revokedAt: new Date() } });
          if (result.count === 1) await tx.auditLog.create({ data: auditLogData(req, { action: "LOGOUT", entity: "SESSION", success: true }) });
        });
      }
    }
    clearSessionCookie(res);
    res.status(204).send();
  } catch (error) { next(error); }
});
app.get("/api/v1/auth/me", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { id: true, name: true, email: true, role: true, active: true, mfaEnabled: true } });
    res.json({ data: { user } });
  } catch (error) { next(error); }
});
app.post("/api/v1/auth/change-password", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      currentPassword: currentPasswordSchema,
      newPassword: passwordSchema,
    }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
    if (user && await checkLoginRateLimit(user.email, getClientIp(req))) {
      return res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many verification attempts. Try again later." } });
    }
    if (!user || !(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
      await recordAuthenticationFailure(req, { email: user?.email ?? "", userId: req.auth!.userId, reason: "INVALID_CREDENTIALS", action: "PASSWORD_CHANGE_FAILED", entity: "USER" });
      return res.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "The current password is incorrect." } });
    }
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(input.newPassword, 12), lastPasswordChangeAt: new Date() } });
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CHANGE_PASSWORD", entity: "USER", entityId: user.id }) });
    });
    clearSessionCookie(res);
    res.json({ data: { changed: true } });
  } catch (error) { next(error); }
});
app.post("/api/v1/auth/mfa/enroll", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ password: currentPasswordSchema }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
    if (user && await checkLoginRateLimit(user.email, getClientIp(req))) {
      return res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many verification attempts. Try again later." } });
    }
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      await recordAuthenticationFailure(req, { email: user?.email ?? "", userId: req.auth!.userId, reason: "INVALID_CREDENTIALS", action: "MFA_ENROLLMENT_REAUTH_FAILED", entity: "USER" });
      return res.status(401).json({ error: { code: "REAUTHENTICATION_REQUIRED", message: "Password verification failed." } });
    }
    if (user.mfaEnabled) return res.status(409).json({ error: { code: "MFA_ALREADY_ENABLED", message: "Multi-factor authentication is already enabled." } });
    const secret = user.mfaPendingSecretEncrypted
      ? decryptMfaSecret(user.mfaPendingSecretEncrypted)
      : generateMfaSecret();
    if (!user.mfaPendingSecretEncrypted) {
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { mfaPendingSecretEncrypted: encryptMfaSecret(secret) } });
        await tx.auditLog.create({ data: auditLogData(req, { action: "MFA_ENROLLMENT_STARTED", entity: "USER", entityId: user.id }) });
      });
    } else {
      await writeAudit(req, { action: "MFA_ENROLLMENT_RESUMED", entity: "USER", entityId: user.id });
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ data: { secret, otpauthUri: createTotpUri(secret, user.email) } });
  } catch (error) { next(error); }
});
app.post("/api/v1/auth/mfa/enable", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
    if (!user?.mfaPendingSecretEncrypted || user.mfaEnabled) {
      return res.status(409).json({ error: { code: "MFA_ENROLLMENT_NOT_PENDING", message: "Start multi-factor enrollment before enabling it." } });
    }
    if (await checkLoginRateLimit(user.email, getClientIp(req))) {
      return res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many verification attempts. Try again later." } });
    }
    if (!verifyTotp(decryptMfaSecret(user.mfaPendingSecretEncrypted), input.code)) {
      await recordAuthenticationFailure(req, { email: user.email, userId: user.id, reason: "MFA_INVALID", action: "MFA_ENROLLMENT_FAILED", entity: "USER" });
      return res.status(400).json({ error: { code: "MFA_CODE_INVALID", message: "The verification code is invalid." } });
    }
    const recoveryCodes = generateRecoveryCodes();
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { mfaEnabled: true, mfaSecretEncrypted: user.mfaPendingSecretEncrypted, mfaPendingSecretEncrypted: null },
      });
      await tx.mfaRecoveryCode.createMany({
        data: recoveryCodes.map((code) => ({ userId: user.id, tokenHash: hashRecoveryCode(code) })),
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "MFA_ENABLED", entity: "USER", entityId: user.id }) });
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ data: { enabled: true, recoveryCodes } });
  } catch (error) { next(error); }
});
app.post("/api/v1/auth/mfa/verify", requireMfaChallenge, async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ code: z.string().min(6).max(32) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
    const token = getSessionToken(req);
    if (!user?.mfaSecretEncrypted || !token) {
      return res.status(401).json({ error: { code: "MFA_CHALLENGE_INVALID", message: "The multi-factor challenge is invalid or expired." } });
    }
    if (await checkLoginRateLimit(user.email, getClientIp(req))) {
      return res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many verification attempts. Try again later." } });
    }
    const validTotp = verifyTotp(decryptMfaSecret(user.mfaSecretEncrypted), input.code);
    try {
      await prisma.$transaction(async (tx) => {
        let usedRecovery = false;
        if (!validTotp) {
          const consumed = await tx.mfaRecoveryCode.updateMany({
            where: { userId: user.id, tokenHash: hashRecoveryCode(input.code), usedAt: null },
            data: { usedAt: new Date() },
          });
          if (consumed.count !== 1) throw new InvalidMfaVerificationError();
          usedRecovery = true;
        }
        const sessionUpdate = await tx.session.updateMany({ where: { tokenHash: hashToken(token), userId: user.id, mfaVerified: false, revokedAt: null, expiresAt: { gt: new Date() } }, data: { mfaVerified: true } });
        if (sessionUpdate.count !== 1) throw new InvalidMfaVerificationError();
        await tx.loginHistory.create({ data: { userId: user.id, email: user.email, successful: true, ipAddress: getClientIp(req), userAgent: req.header("user-agent")?.slice(0, 500) } });
        await tx.auditLog.create({ data: auditLogData(req, { action: "LOGIN", entity: "SESSION", success: true, metadata: { method: usedRecovery ? "RECOVERY_CODE" : "TOTP" } }) });
      });
    } catch (error) {
      if (!(error instanceof InvalidMfaVerificationError)) throw error;
      await prisma.$transaction(async (tx) => {
        await tx.loginHistory.create({ data: { userId: user.id, email: user.email, successful: false, failureReason: "MFA_INVALID", ipAddress: getClientIp(req), userAgent: req.header("user-agent")?.slice(0, 500) } });
        await tx.auditLog.create({ data: auditLogData(req, { action: "MFA_VERIFICATION_FAILED", entity: "SESSION", success: false }) });
      });
      return res.status(401).json({ error: { code: "MFA_CODE_INVALID", message: "The verification code is invalid." } });
    }
    res.json({ data: { verified: true } });
  } catch (error) { next(error); }
});
app.post("/api/v1/auth/mfa/disable", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ password: currentPasswordSchema, code: z.string().min(6).max(32) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
    if (!user?.mfaEnabled || !user.mfaSecretEncrypted) {
      return res.status(409).json({ error: { code: "MFA_NOT_ENABLED", message: "Multi-factor authentication is not enabled." } });
    }
    if (await checkLoginRateLimit(user.email, getClientIp(req))) {
      return res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many verification attempts. Try again later." } });
    }
    if (!(await bcrypt.compare(input.password, user.passwordHash))) {
      await recordAuthenticationFailure(req, { email: user.email, userId: user.id, reason: "INVALID_CREDENTIALS", action: "MFA_DISABLE_FAILED", entity: "USER" });
      return res.status(401).json({ error: { code: "REAUTHENTICATION_REQUIRED", message: "Password verification failed." } });
    }
    const validTotp = verifyTotp(decryptMfaSecret(user.mfaSecretEncrypted), input.code);
    const token = getSessionToken(req);
    try {
      await prisma.$transaction(async (tx) => {
        let usedRecovery = false;
        if (!validTotp) {
          const consumed = await tx.mfaRecoveryCode.updateMany({
            where: { userId: user.id, tokenHash: hashRecoveryCode(input.code), usedAt: null },
            data: { usedAt: new Date() },
          });
          if (consumed.count !== 1) throw new InvalidMfaVerificationError();
          usedRecovery = true;
        }
        await tx.user.update({ where: { id: user.id }, data: { mfaEnabled: false, mfaSecretEncrypted: null, mfaPendingSecretEncrypted: null } });
        await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
        await tx.session.updateMany({ where: { userId: user.id, revokedAt: null, ...(token ? { tokenHash: { not: hashToken(token) } } : {}) }, data: { revokedAt: new Date() } });
        await tx.auditLog.create({ data: auditLogData(req, { action: "MFA_DISABLED", entity: "USER", entityId: user.id, metadata: { method: usedRecovery ? "RECOVERY_CODE" : "TOTP" } }) });
      });
    } catch (error) {
      if (!(error instanceof InvalidMfaVerificationError)) throw error;
      await recordAuthenticationFailure(req, { email: user.email, userId: user.id, reason: "MFA_INVALID", action: "MFA_DISABLE_FAILED", entity: "USER" });
      return res.status(401).json({ error: { code: "MFA_CODE_INVALID", message: "The verification code is invalid." } });
    }
    res.json({ data: { disabled: true } });
  } catch (error) { next(error); }
});
app.get("/api/v1/auth/sessions", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const sessions = await prisma.session.findMany({
      where: { userId: req.auth!.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, ipAddress: true, userAgent: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: { items: sessions } });
  } catch (error) { next(error); }
});
app.delete("/api/v1/auth/sessions/:id", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const revoked = await tx.session.updateMany({
        where: { id: String(req.params.id), userId: req.auth!.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "REVOKE_SESSION", entity: "SESSION", entityId: String(req.params.id), success: revoked.count === 1 }) });
      return revoked;
    });
    res.json({ data: { revoked: result.count === 1 } });
  } catch (error) { next(error); }
});
app.get("/api/v1/admin/users", requireAuth, requireRole(...administratorRoles), async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
    const [items, total] = await prisma.$transaction([
      prisma.user.findMany({
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: { id: true, email: true, name: true, role: true, active: true, mfaEnabled: true, createdAt: true, updatedAt: true },
      }),
      prisma.user.count(),
    ]);
    await writeAudit(req, { action: "LIST_USERS", entity: "USER" });
    res.json({ data: { items, page, limit, total } });
  } catch (error) { next(error); }
});
app.post("/api/v1/admin/users", requireAuth, requireRole(...administratorRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
      name: z.string().trim().min(1).max(120),
      password: passwordSchema,
      role: z.nativeEnum(Role),
    }).parse(req.body);
    if (!canAssignRole(req.auth!.role, input.role)) {
      return res.status(403).json({ error: { code: "ROLE_GRANT_FORBIDDEN", message: "You cannot assign that role." } });
    }
    if (await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } })) {
      return res.status(409).json({ error: { code: "USER_EXISTS", message: "An account with that email already exists." } });
    }
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { email: input.email, name: input.name, passwordHash: await bcrypt.hash(input.password, 12), role: input.role },
        select: { id: true, email: true, name: true, role: true, active: true, mfaEnabled: true, createdAt: true },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "USER_CREATED", entity: "USER", entityId: created.id, metadata: { role: created.role } }) });
      return created;
    });
    res.status(201).json({ data: { user } });
  } catch (error) { next(error); }
});
app.patch("/api/v1/admin/users/:id", requireAuth, requireRole(...administratorRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      name: z.string().trim().min(1).max(120).optional(),
      role: z.nativeEnum(Role).optional(),
      active: z.boolean().optional(),
    }).refine((value) => Object.keys(value).length > 0, "Provide at least one field to update.").parse(req.body);
    const target = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
    if (!target) return res.status(404).json({ error: { code: "USER_NOT_FOUND", message: "The requested account was not found." } });
    if (target.id === req.auth!.userId && (input.active === false || input.role !== undefined)) {
      return res.status(409).json({ error: { code: "SELF_ADMIN_CHANGE_BLOCKED", message: "You cannot deactivate or change the role of your own account." } });
    }
    if (!canAssignRole(req.auth!.role, target.role)) {
      return res.status(403).json({ error: { code: "ROLE_GRANT_FORBIDDEN", message: "Only a super administrator can modify this account." } });
    }
    if (input.role && !canAssignRole(req.auth!.role, input.role)) {
      return res.status(403).json({ error: { code: "ROLE_GRANT_FORBIDDEN", message: "You cannot assign that role." } });
    }
    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: target.id },
        data: { name: input.name, role: input.role, active: input.active },
        select: { id: true, email: true, name: true, role: true, active: true, mfaEnabled: true, createdAt: true, updatedAt: true },
      });
      if (input.active === false || input.role !== undefined) {
        await tx.session.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await tx.auditLog.create({
        data: auditLogData(req, { action: input.role ? "USER_ROLE_CHANGED" : input.active === false ? "USER_DEACTIVATED" : input.active ? "USER_ACTIVATED" : "USER_UPDATED", entity: "USER", entityId: target.id, metadata: { role: input.role, active: input.active } }),
      });
      return updated;
    });
    res.json({ data: { user } });
  } catch (error) { next(error); }
});

app.get("/api/v1/dashboard/summary", requireAuth, requireRole(...patientReadRoles, Role.PHARMACIST, Role.LAB_TECHNICIAN, Role.RADIOLOGIST, Role.BILLING_STAFF, Role.ACCOUNTANT, Role.HOUSEKEEPING), async (req: AuthenticatedRequest, res, next) => {
  try {
    const [patients, appointments, occupied, beds, doctors, labs] = await Promise.all([
      prisma.patient.count(), prisma.appointment.count({ where: { startsAt: { gte: new Date(new Date().setHours(0,0,0,0)) } } }),
      prisma.bed.count({ where: { status: "OCCUPIED" } }), prisma.bed.count(), prisma.doctor.count({ where: { onDuty: true } }),
      prisma.labOrder.count({ where: { status: { not: "COMPLETED" } } }),
    ]);
    const data = { patients, appointments, occupiedBeds: occupied, availableBeds: beds - occupied, doctorsOnDuty: doctors, pendingLabs: labs };
    if (billingRoles.includes(req.auth!.role as (typeof billingRoles)[number])) {
      const [invoices, revenue] = await Promise.all([
        prisma.invoice.count({ where: { status: { not: "PAID" } } }),
        prisma.payment.aggregate({ _sum: { amount: true } }),
      ]);
      return res.json({ data: { ...data, pendingInvoices: invoices, revenue: Number(revenue._sum.amount ?? 0) } });
    }
    res.json({ data });
  } catch (error) { next(error); }
});
app.get("/api/v1/patients", requireAuth, requireRole(...patientReadRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page ?? 1)); const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
    const search = String(req.query.search ?? "").trim();
    const where: Prisma.PatientWhereInput = search ? { OR: [{ firstName: { contains: search, mode: "insensitive" } }, { lastName: { contains: search, mode: "insensitive" } }, { patientNumber: { contains: search, mode: "insensitive" } }] } : {};
    if (req.auth!.role === Role.DOCTOR) {
      const doctor = await prisma.doctor.findUnique({ where: { userId: req.auth!.userId }, select: { departmentId: true } });
      if (!doctor) return res.status(403).json({ error: { code: "DOCTOR_PROFILE_REQUIRED", message: "A doctor profile is required for this resource." } });
      where.departmentId = doctor.departmentId;
    }
    const [items, total] = await prisma.$transaction([prisma.patient.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: "desc" }, include: { department: true } }), prisma.patient.count({ where })]);
    await writeAudit(req, { action: "READ", entity: "PATIENT", metadata: { page, limit, searchPerformed: Boolean(search) } });
    res.json({ data: { items, page, limit, total } });
  } catch (error) { next(error); }
});
app.post("/api/v1/patients", requireAuth, requireRole(Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN, Role.RECEPTIONIST, Role.DOCTOR), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ firstName: z.string().min(1).max(80), lastName: z.string().min(1).max(80), dateOfBirth: z.coerce.date(), phone: z.string().min(7).max(30), emergencyContact: z.string().max(120).optional(), departmentId: z.string().optional() }).parse(req.body);
    if (req.auth!.role === Role.DOCTOR) {
      const doctor = await prisma.doctor.findUnique({ where: { userId: req.auth!.userId }, select: { departmentId: true } });
      if (!doctor) return res.status(403).json({ error: { code: "DOCTOR_PROFILE_REQUIRED", message: "A doctor profile is required for this resource." } });
      if (input.departmentId && input.departmentId !== doctor.departmentId) {
        return res.status(403).json({ error: { code: "RESOURCE_SCOPE_FORBIDDEN", message: "You cannot assign a patient outside your department." } });
      }
      input.departmentId = doctor.departmentId;
    }
    const patient = await prisma.$transaction(async (tx) => {
      const created = await tx.patient.create({ data: { ...input, patientNumber: `PT-${Date.now().toString().slice(-8)}` } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE", entity: "PATIENT", entityId: created.id }) });
      return created;
    });
    res.status(201).json({ data: patient });
  } catch (error) { next(error); }
});
app.patch("/api/v1/patients/:id", requireAuth, requireRole(Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN, Role.RECEPTIONIST, Role.DOCTOR), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      firstName: z.string().min(1).max(80).optional(),
      lastName: z.string().min(1).max(80).optional(),
      dateOfBirth: z.coerce.date().optional(),
      phone: z.string().min(7).max(30).optional(),
      emergencyContact: z.string().max(120).optional(),
      departmentId: z.string().nullable().optional(),
    }).parse(req.body);
    if (req.auth!.role === Role.DOCTOR && Object.hasOwn(req.body, "departmentId")) {
      return res.status(403).json({ error: { code: "RESOURCE_SCOPE_FORBIDDEN", message: "Doctors cannot reassign patient departments." } });
    }
    if (req.auth!.role === Role.DOCTOR) {
      const doctor = await prisma.doctor.findUnique({ where: { userId: req.auth!.userId }, select: { departmentId: true } });
      if (!doctor) return res.status(403).json({ error: { code: "DOCTOR_PROFILE_REQUIRED", message: "A doctor profile is required for this resource." } });
      const patient = await prisma.$transaction(async (tx) => {
        const result = await tx.patient.updateMany({
          where: { id: String(req.params.id), departmentId: doctor.departmentId },
          data: input,
        });
        if (result.count !== 1) return null;
        const updated = await tx.patient.findUniqueOrThrow({ where: { id: String(req.params.id) }, include: { department: true } });
        await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE", entity: "PATIENT", entityId: updated.id }) });
        return updated;
      });
      if (!patient) return res.status(404).json({ error: { code: "PATIENT_NOT_FOUND", message: "The requested patient was not found." } });
      return res.json({ data: patient });
    }
    const patient = await prisma.$transaction(async (tx) => {
      const updated = await tx.patient.update({ where: { id: String(req.params.id) }, data: input, include: { department: true } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE", entity: "PATIENT", entityId: updated.id }) });
      return updated;
    });
    res.json({ data: patient });
  } catch (error) { next(error); }
});
app.get("/api/v1/appointments", requireAuth, requireRole(...appointmentRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const where = req.auth!.role === Role.DOCTOR ? { doctor: { userId: req.auth!.userId } } : undefined;
    const items = await prisma.appointment.findMany({
      where,
      orderBy: { startsAt: "asc" },
      include: { patient: true, doctor: { include: { user: true } }, department: true },
    });
    await writeAudit(req, { action: "READ", entity: "APPOINTMENT" });
    res.json({ data: items });
  } catch (error) { next(error); }
});
app.patch("/api/v1/appointments/:id/status", requireAuth, requireRole(Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN, Role.RECEPTIONIST, Role.DOCTOR), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ status: z.nativeEnum(AppointmentStatus) }).parse(req.body);
    const appointment = await prisma.$transaction(async (tx) => {
      const where = req.auth!.role === Role.DOCTOR
        ? { id: String(req.params.id), doctor: { userId: req.auth!.userId } }
        : { id: String(req.params.id) };
      const result = await tx.appointment.updateMany({ where, data: { status: input.status } });
      if (result.count !== 1) return null;
      const updated = await tx.appointment.findUniqueOrThrow({ where: { id: String(req.params.id) } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE_STATUS", entity: "APPOINTMENT", entityId: updated.id, metadata: { status: input.status } }) });
      return updated;
    });
    if (!appointment) return res.status(404).json({ error: { code: "APPOINTMENT_NOT_FOUND", message: "The requested appointment was not found." } });
    res.json({ data: appointment });
  } catch (error) { next(error); }
});
app.get("/api/v1/admissions", requireAuth, requireRole(...admissionRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const doctor = req.auth!.role === Role.DOCTOR
      ? await prisma.doctor.findUnique({ where: { userId: req.auth!.userId }, select: { departmentId: true } })
      : null;
    if (req.auth!.role === Role.DOCTOR && !doctor) return res.status(403).json({ error: { code: "DOCTOR_PROFILE_REQUIRED", message: "A doctor profile is required for this resource." } });
    const where = doctor ? { patient: { is: { departmentId: doctor.departmentId } } } : undefined;
    const items = await prisma.admission.findMany({ where, orderBy: { admittedAt: "desc" }, include: { patient: true, bed: { include: { ward: { include: { department: true } } } } } });
    await writeAudit(req, { action: "READ", entity: "ADMISSION" });
    res.json({ data: items });
  } catch (error) { next(error); }
});
app.patch("/api/v1/admissions/:id/status", requireAuth, requireRole(Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN, Role.DOCTOR, Role.NURSE), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ status: z.nativeEnum(AdmissionStatus) }).parse(req.body);
    const doctor = req.auth!.role === Role.DOCTOR
      ? await prisma.doctor.findUnique({ where: { userId: req.auth!.userId }, select: { departmentId: true } })
      : null;
    if (req.auth!.role === Role.DOCTOR && !doctor) return res.status(403).json({ error: { code: "DOCTOR_PROFILE_REQUIRED", message: "A doctor profile is required for this resource." } });
    const admission = await prisma.$transaction(async (tx) => {
      const where: Prisma.AdmissionWhereInput = doctor
        ? { id: String(req.params.id), patient: { departmentId: doctor.departmentId } }
        : { id: String(req.params.id) };
      const changed = await tx.admission.updateMany({ where, data: { status: input.status, dischargedAt: input.status === AdmissionStatus.DISCHARGED ? new Date() : null } });
      if (changed.count !== 1) return null;
      const updated = await tx.admission.findUniqueOrThrow({ where: { id: String(req.params.id) } });
      await tx.bed.update({ where: { id: updated.bedId }, data: { status: input.status === AdmissionStatus.DISCHARGED ? "AVAILABLE" : "OCCUPIED" } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE_STATUS", entity: "ADMISSION", entityId: updated.id, metadata: { status: input.status } }) });
      return updated;
    });
    if (!admission) return res.status(404).json({ error: { code: "ADMISSION_NOT_FOUND", message: "The requested admission was not found." } });
    res.json({ data: admission });
  } catch (error) { next(error); }
});
app.get("/api/v1/lab-orders", requireAuth, requireRole(...labRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const doctor = req.auth!.role === Role.DOCTOR
      ? await prisma.doctor.findUnique({ where: { userId: req.auth!.userId }, select: { departmentId: true } })
      : null;
    if (req.auth!.role === Role.DOCTOR && !doctor) return res.status(403).json({ error: { code: "DOCTOR_PROFILE_REQUIRED", message: "A doctor profile is required for this resource." } });
    const where = doctor ? { patient: { is: { departmentId: doctor.departmentId } } } : undefined;
    const items = await prisma.labOrder.findMany({ where, orderBy: { createdAt: "desc" }, include: { patient: true, result: true } });
    await writeAudit(req, { action: "READ", entity: "LAB_ORDER" });
    res.json({ data: items });
  } catch (error) { next(error); }
});
app.patch("/api/v1/lab-orders/:id/status", requireAuth, requireRole(Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN, Role.LAB_TECHNICIAN, Role.RADIOLOGIST, Role.DOCTOR), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ status: z.nativeEnum(LabStatus) }).parse(req.body);
    const doctor = req.auth!.role === Role.DOCTOR
      ? await prisma.doctor.findUnique({ where: { userId: req.auth!.userId }, select: { departmentId: true } })
      : null;
    if (req.auth!.role === Role.DOCTOR && !doctor) return res.status(403).json({ error: { code: "DOCTOR_PROFILE_REQUIRED", message: "A doctor profile is required for this resource." } });
    const order = await prisma.$transaction(async (tx) => {
      const where: Prisma.LabOrderWhereInput = doctor
        ? { id: String(req.params.id), patient: { departmentId: doctor.departmentId } }
        : { id: String(req.params.id) };
      const changed = await tx.labOrder.updateMany({ where, data: { status: input.status } });
      if (changed.count !== 1) return null;
      const updated = await tx.labOrder.findUniqueOrThrow({ where: { id: String(req.params.id) } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE_STATUS", entity: "LAB_ORDER", entityId: updated.id, metadata: { status: input.status } }) });
      return updated;
    });
    if (!order) return res.status(404).json({ error: { code: "LAB_ORDER_NOT_FOUND", message: "The requested laboratory order was not found." } });
    res.json({ data: order });
  } catch (error) { next(error); }
});
app.get("/api/v1/invoices", requireAuth, requireRole(...billingRoles), async (req, res, next) => {
  try {
    const items = await prisma.invoice.findMany({ orderBy: { createdAt: "desc" }, include: { patient: true } });
    await writeAudit(req, { action: "READ", entity: "INVOICE" });
    res.json({ data: items });
  } catch (error) { next(error); }
});
app.patch("/api/v1/invoices/:id/status", requireAuth, requireRole(Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN, Role.ACCOUNTANT, Role.BILLING_STAFF), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ status: z.nativeEnum(InvoiceStatus) }).parse(req.body);
    const invoice = await prisma.$transaction(async (tx) => {
      const updated = await tx.invoice.update({ where: { id: String(req.params.id) }, data: { status: input.status, balance: input.status === InvoiceStatus.PAID ? 0 : undefined } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE_STATUS", entity: "INVOICE", entityId: updated.id, metadata: { status: input.status } }) });
      return updated;
    });
    res.json({ data: invoice });
  } catch (error) { next(error); }
});
app.use("/api/v1", clinicalRouter);
app.use("/api/v1", portalRouter);
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: error.issues[0]?.message ?? "Invalid request" } });
  if (error instanceof SyntaxError) return res.status(400).json({ error: { code: "INVALID_JSON", message: "The request body is not valid JSON." } });
  if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
    return res.status(409).json({ error: { code: "CONFLICT", message: "A record with the supplied unique value already exists." } });
  }
  if (typeof error === "object" && error !== null && "code" in error && error.code === "P2025") {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "The requested record was not found." } });
  }
  const errorName = error instanceof Error ? error.name : "UnknownError";
  console.error("API request failed", { name: errorName });
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } });
});

export default app;
