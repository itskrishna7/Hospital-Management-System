import crypto from "node:crypto";
import { OutboxEventStatus, OutboxEventType, NotificationChannel, NotificationDeliveryStatus, PortalAccessScope, Prisma, Role } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { auditLogData, requireAuth, requireRole, type AuthenticatedRequest } from "./auth.js";
import { env } from "./config/env.js";
import { prisma } from "./db.js";
import { DeliveryUnavailableError, sendPortalEmail } from "./notification-delivery.js";
import { refreshOperationalAlerts } from "./intelligence.js";

export const reliableEventsRouter = Router();

const staffRoles = [
  Role.SUPER_ADMIN,
  Role.HOSPITAL_ADMIN,
  Role.ADMIN,
  Role.DOCTOR,
  Role.NURSE,
  Role.RECEPTIONIST,
  Role.LAB_TECHNICIAN,
  Role.RADIOLOGIST,
  Role.BILLING_STAFF,
  Role.ACCOUNTANT,
  Role.HOUSEKEEPING,
] as const;
const adminRoles = [Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN] as const;
const maxAttempts = 3;
const lockDurationMs = 10 * 60 * 1000;
const retryDelaysMs = [60 * 60 * 1000, 6 * 60 * 60 * 1000];

const portalEventInput = z.object({
  patientId: z.string().min(1),
  category: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(1000),
  notifyStaff: z.boolean().default(false),
});

type PortalNotificationEvent = z.infer<typeof portalEventInput>;

export async function enqueuePortalNotification(
  tx: Prisma.TransactionClient,
  input: Omit<PortalNotificationEvent, "notifyStaff"> & { notifyStaff?: boolean; idempotencyKey: string },
) {
  const { idempotencyKey, ...payload } = input;
  const event = await tx.outboxEvent.create({
    data: {
      type: OutboxEventType.PORTAL_NOTIFICATION,
      idempotencyKey,
      payload: { ...payload, notifyStaff: payload.notifyStaff ?? false },
    },
    select: { id: true },
  });
  return event.id;
}

async function createPortalNotificationForUser(
  tx: Prisma.TransactionClient,
  eventId: string,
  userId: string,
  category: string,
  title: string,
  message: string,
) {
  return tx.portalNotification.upsert({
    where: { sourceEventId_userId: { sourceEventId: eventId, userId } },
    create: { sourceEventId: eventId, userId, category, title, message },
    update: {},
    select: { id: true },
  });
}

async function completeClaimedEvent(tx: Prisma.TransactionClient, eventId: string, lockToken: string) {
  const result = await tx.outboxEvent.updateMany({
    where: { id: eventId, status: OutboxEventStatus.PROCESSING, lockToken },
    data: {
      status: OutboxEventStatus.COMPLETED,
      processedAt: new Date(),
      lockedAt: null,
      lockToken: null,
      lastError: null,
    },
  });
  if (result.count !== 1) throw new Error("The outbox event lease was lost before completion.");
}

async function processPortalNotification(eventId: string, lockToken: string, payload: unknown) {
  const input = portalEventInput.parse(payload);
  await prisma.$transaction(async (tx) => {
    const patient = await tx.patient.findUnique({
      where: { id: input.patientId },
      select: {
        id: true,
        departmentId: true,
        portalUser: { select: { id: true, email: true, emailVerifiedAt: true } },
      },
    });
    const scope = input.category === "APPOINTMENT"
      ? [PortalAccessScope.APPOINTMENTS]
      : [PortalAccessScope.APPOINTMENTS, PortalAccessScope.JOURNEY];
    const grants = await tx.patientAccessGrant.findMany({
      where: {
        patientId: input.patientId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        scopes: { hasSome: scope },
        grantee: { active: true },
      },
      select: { granteeUserId: true },
    });
    const familyUserIds = [...new Set(grants.map((grant) => grant.granteeUserId))];
    for (const userId of familyUserIds) {
      const preference = await tx.portalNotificationPreference.upsert({
        where: { userId },
        create: { userId },
        update: {},
        select: { inAppEnabled: true },
      });
      if (preference.inAppEnabled) {
        await createPortalNotificationForUser(tx, eventId, userId, input.category, input.title, input.message);
      }
    }

    const patientUser = patient?.portalUser;
    if (patientUser) {
      const preference = await tx.portalNotificationPreference.upsert({
        where: { userId: patientUser.id },
        create: { userId: patientUser.id },
        update: {},
        select: { inAppEnabled: true, emailEnabled: true },
      });
      if (preference.inAppEnabled || preference.emailEnabled) {
        const notification = await createPortalNotificationForUser(
          tx,
          eventId,
          patientUser.id,
          input.category,
          input.title,
          input.message,
        );
        if (preference.emailEnabled && patientUser.emailVerifiedAt) {
          const delivery = await tx.notificationDelivery.upsert({
            where: { notificationId_channel: { notificationId: notification.id, channel: NotificationChannel.EMAIL } },
            create: {
              notificationId: notification.id,
              channel: NotificationChannel.EMAIL,
              destination: patientUser.email,
            },
            update: {},
            select: { id: true, status: true },
          });
          if (delivery.status !== NotificationDeliveryStatus.SENT) {
            await tx.outboxEvent.upsert({
              where: { idempotencyKey: `portal-email:${delivery.id}` },
              create: {
                type: OutboxEventType.PORTAL_EMAIL,
                idempotencyKey: `portal-email:${delivery.id}`,
                payload: { deliveryId: delivery.id },
                parentEventId: eventId,
                deliveryId: delivery.id,
              },
              update: {},
            });
          }
        }
      }
    }

    if (input.notifyStaff) {
      const recipients = await tx.user.findMany({
        where: {
          active: true,
          role: { in: staffRoles.filter((role) => role !== Role.DOCTOR) },
        },
        select: { id: true },
      });
      const doctors = patient?.departmentId
        ? await tx.user.findMany({
            where: { active: true, role: Role.DOCTOR, doctor: { is: { departmentId: patient.departmentId } } },
            select: { id: true },
          })
        : [];
      const recipientIds = [...new Set([...recipients, ...doctors].map((recipient) => recipient.id))];
      if (recipientIds.length) {
        await tx.staffNotification.createMany({
          data: recipientIds.map((recipientUserId) => ({
            eventId,
            recipientUserId,
            category: input.category,
            title: input.title,
            message: input.message,
          })),
          skipDuplicates: true,
        });
      }
    }
    await completeClaimedEvent(tx, eventId, lockToken);
  });
}

async function processPortalEmail(eventId: string, lockToken: string, payload: unknown, attempt: number) {
  const input = z.object({ deliveryId: z.string().min(1) }).parse(payload);
  const delivery = await prisma.notificationDelivery.findUnique({
    where: { id: input.deliveryId },
    include: { notification: { select: { title: true, message: true } } },
  });
  if (!delivery || delivery.channel !== NotificationChannel.EMAIL) {
    throw new Error("The notification delivery referenced by the outbox event does not exist.");
  }
  await sendPortalEmail(
    delivery.destination,
    delivery.notification.title,
    `${delivery.notification.message}\nSign in to MediVerse to view details.`,
  );
  await prisma.$transaction(async (tx) => {
    await tx.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: NotificationDeliveryStatus.SENT,
        attempts: attempt,
        sentAt: new Date(),
        lastError: null,
      },
    });
    await completeClaimedEvent(tx, eventId, lockToken);
  });
}

async function claimOutboxEvent(eventId: string) {
  const now = new Date();
  const lockToken = crypto.randomUUID();
  const claimed = await prisma.outboxEvent.updateMany({
    where: {
      id: eventId,
      OR: [
        { status: OutboxEventStatus.PENDING, availableAt: { lte: now }, attempts: { lt: maxAttempts } },
        { status: OutboxEventStatus.PROCESSING, lockedAt: { lte: new Date(now.getTime() - lockDurationMs) }, attempts: { lt: maxAttempts } },
      ],
    },
    data: {
      status: OutboxEventStatus.PROCESSING,
      attempts: { increment: 1 },
      lockedAt: now,
      lockToken,
    },
  });
  if (claimed.count !== 1) return null;
  return prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId, lockToken } });
}

async function failClaimedEvent(event: {
  id: string;
  type: OutboxEventType;
  payload: Prisma.JsonValue;
  attempts: number;
  lockToken: string | null;
}, error: unknown) {
  if (!event.lockToken) throw new Error("A claimed outbox event is missing its lease token.");
  const isEmail = event.type === OutboxEventType.PORTAL_EMAIL;
  const deliveryId = isEmail && typeof event.payload === "object" && event.payload !== null && "deliveryId" in event.payload
    ? String(event.payload.deliveryId)
    : null;
  const lastError = isEmail
    ? error instanceof DeliveryUnavailableError ? error.message : "The configured email provider could not deliver the message."
    : "The notification event could not be processed.";
  const terminal = event.attempts >= maxAttempts;
  const availableAt = new Date(Date.now() + (retryDelaysMs[event.attempts - 1] ?? retryDelaysMs.at(-1)!));
  await prisma.$transaction(async (tx) => {
    if (deliveryId) {
      await tx.notificationDelivery.updateMany({
        where: { id: deliveryId },
        data: {
          status: NotificationDeliveryStatus.FAILED,
          attempts: event.attempts,
          lastError: lastError.slice(0, 200),
        },
      });
    }
    const updated = await tx.outboxEvent.updateMany({
      where: { id: event.id, status: OutboxEventStatus.PROCESSING, lockToken: event.lockToken },
      data: {
        status: terminal ? OutboxEventStatus.FAILED : OutboxEventStatus.PENDING,
        availableAt,
        lockedAt: null,
        lockToken: null,
        lastError: lastError.slice(0, 200),
      },
    });
    if (updated.count !== 1) throw new Error("The outbox event lease was lost while recording a failed attempt.");
  });
}

export async function processOutboxEvent(eventId: string) {
  const event = await claimOutboxEvent(eventId);
  if (!event) return;
  try {
    if (event.type === OutboxEventType.PORTAL_NOTIFICATION) {
      await processPortalNotification(event.id, event.lockToken!, event.payload);
    } else if (event.type === OutboxEventType.PORTAL_EMAIL) {
      await processPortalEmail(event.id, event.lockToken!, event.payload, event.attempts);
    } else {
      throw new Error("The outbox event type is not supported.");
    }
  } catch (error) {
    await failClaimedEvent(event, error);
    console.error("Outbox event processing failed", {
      eventId: event.id,
      type: event.type,
      name: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export async function processOutboxTree(eventId: string) {
  await processOutboxEvent(eventId);
  const children = await prisma.outboxEvent.findMany({
    where: {
      parentEventId: eventId,
      type: OutboxEventType.PORTAL_EMAIL,
      status: OutboxEventStatus.PENDING,
      availableAt: { lte: new Date() },
    },
    select: { id: true },
  });
  await Promise.all(children.map(({ id }) => processOutboxEvent(id)));
  const deliveries = await prisma.notificationDelivery.findMany({
    where: { outboxEvent: { parentEventId: eventId } },
    select: { channel: true, status: true },
  });
  return deliveries;
}

export async function retryNotificationDelivery(deliveryId: string) {
  const delivery = await prisma.notificationDelivery.findUnique({
    where: { id: deliveryId },
    include: { outboxEvent: { select: { id: true, status: true, attempts: true } } },
  });
  if (!delivery || !delivery.outboxEvent || delivery.attempts >= maxAttempts || delivery.status !== NotificationDeliveryStatus.FAILED) {
    return false;
  }
  const event = await prisma.outboxEvent.updateMany({
    where: {
      id: delivery.outboxEvent.id,
      status: { in: [OutboxEventStatus.PENDING, OutboxEventStatus.FAILED] },
      attempts: { lt: maxAttempts },
    },
    data: {
      status: OutboxEventStatus.PENDING,
      availableAt: new Date(),
      lastError: null,
    },
  });
  if (event.count !== 1) return false;
  await processOutboxEvent(delivery.outboxEvent.id);
  return true;
}

async function processOutboxBatch(limit: number) {
  const staleLock = new Date(Date.now() - lockDurationMs);
  const staleEvents = await prisma.outboxEvent.findMany({
    where: {
      status: OutboxEventStatus.PROCESSING,
      lockedAt: { lte: staleLock },
      attempts: { gte: maxAttempts },
    },
    select: { id: true, deliveryId: true, attempts: true, lockToken: true },
  });
  if (staleEvents.length) {
    await prisma.$transaction(async (tx) => {
      for (const event of staleEvents) {
        const expired = await tx.outboxEvent.updateMany({
          where: { id: event.id, status: OutboxEventStatus.PROCESSING, lockToken: event.lockToken },
          data: {
            status: OutboxEventStatus.FAILED,
            lockedAt: null,
            lockToken: null,
            lastError: "Processing stopped before the final attempt could be recorded.",
          },
        });
        if (expired.count !== 1) continue;
        if (event.deliveryId) {
          await tx.notificationDelivery.updateMany({
            where: { id: event.deliveryId },
            data: {
              status: NotificationDeliveryStatus.FAILED,
              attempts: event.attempts,
              lastError: "Processing stopped before the final attempt could be recorded.",
            },
          });
        }
      }
    });
  }
  const considered = new Set<string>();
  while (considered.size < limit) {
    const now = new Date();
    const candidate = await prisma.outboxEvent.findFirst({
      where: {
        id: { notIn: [...considered] },
        OR: [
          { status: OutboxEventStatus.PENDING, availableAt: { lte: now }, attempts: { lt: maxAttempts } },
          { status: OutboxEventStatus.PROCESSING, lockedAt: { lte: new Date(now.getTime() - lockDurationMs) }, attempts: { lt: maxAttempts } },
        ],
      },
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    if (!candidate) break;
    considered.add(candidate.id);
    await processOutboxEvent(candidate.id);
  }
  return { attempted: considered.size };
}

function matchesCronSecret(provided: string | undefined, expected: string) {
  if (!provided) return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(`Bearer ${expected}`);
  return providedBytes.length === expectedBytes.length && crypto.timingSafeEqual(providedBytes, expectedBytes);
}

reliableEventsRouter.get("/internal/cron/process-outbox", async (req, res, next) => {
  try {
    if (!env.CRON_SECRET) {
      return res.status(503).json({ error: { code: "CRON_NOT_CONFIGURED", message: "Scheduled event processing is not configured." } });
    }
    if (!matchesCronSecret(req.header("authorization"), env.CRON_SECRET)) {
      return res.status(401).json({ error: { code: "CRON_UNAUTHORIZED", message: "The scheduled request is not authorized." } });
    }
    const [outbox, alerts] = await Promise.all([
      processOutboxBatch(10),
      refreshOperationalAlerts(),
    ]);
    res.json({ data: { ...outbox, alerts } });
  } catch (error) {
    next(error);
  }
});

reliableEventsRouter.get("/notifications/staff", requireAuth, requireRole(...staffRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const [items, unreadCount] = await Promise.all([
      prisma.staffNotification.findMany({
        where: { recipientUserId: req.auth!.userId },
        select: { id: true, category: true, title: true, message: true, readAt: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      prisma.staffNotification.count({ where: { recipientUserId: req.auth!.userId, readAt: null } }),
    ]);
    res.json({ data: { items, unreadCount } });
  } catch (error) {
    next(error);
  }
});

reliableEventsRouter.get("/operations/outbox", requireAuth, requireRole(...adminRoles), async (_req, res, next) => {
  try {
    const [counts, failedEvents] = await Promise.all([
      prisma.outboxEvent.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.outboxEvent.findMany({
        where: { status: OutboxEventStatus.FAILED },
        select: { id: true, type: true, attempts: true, lastError: true, createdAt: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 50,
      }),
    ]);
    res.json({
      data: {
        counts: Object.fromEntries(counts.map((row) => [row.status, row._count._all])),
        failedEvents,
      },
    });
  } catch (error) {
    next(error);
  }
});

reliableEventsRouter.post("/operations/outbox/:id/retry", requireAuth, requireRole(...adminRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const event = await prisma.$transaction(async (tx) => {
      const current = await tx.outboxEvent.findUnique({
        where: { id: String(req.params.id) },
        include: { delivery: { select: { id: true } } },
      });
      if (!current || current.status !== OutboxEventStatus.FAILED) return null;
      await tx.outboxEvent.update({
        where: { id: current.id },
        data: {
          status: OutboxEventStatus.PENDING,
          attempts: 0,
          availableAt: new Date(),
          lockedAt: null,
          lockToken: null,
          processedAt: null,
          lastError: null,
        },
      });
      if (current.delivery) {
        await tx.notificationDelivery.update({
          where: { id: current.delivery.id },
          data: { status: NotificationDeliveryStatus.PENDING, attempts: 0, sentAt: null, lastError: null },
        });
      }
      await tx.auditLog.create({
        data: auditLogData(req, { action: "RETRY_OUTBOX_EVENT", entity: "OUTBOX_EVENT", entityId: current.id }),
      });
      return current.id;
    });
    if (!event) {
      return res.status(404).json({ error: { code: "FAILED_OUTBOX_EVENT_NOT_FOUND", message: "A failed outbox event was not found." } });
    }
    await processOutboxTree(event);
    const updated = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: event },
      select: { id: true, status: true, attempts: true, lastError: true },
    });
    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});

reliableEventsRouter.patch("/notifications/staff/:id/read", requireAuth, requireRole(...staffRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const changed = await prisma.staffNotification.updateMany({
      where: { id: String(req.params.id), recipientUserId: req.auth!.userId, readAt: null },
      data: { readAt: new Date() },
    });
    if (changed.count !== 1) {
      return res.status(404).json({ error: { code: "STAFF_NOTIFICATION_NOT_FOUND", message: "The staff alert was not found." } });
    }
    await prisma.auditLog.create({
      data: auditLogData(req, { action: "READ", entity: "STAFF_NOTIFICATION", entityId: String(req.params.id) }),
    });
    res.json({ data: { read: true } });
  } catch (error) {
    next(error);
  }
});
