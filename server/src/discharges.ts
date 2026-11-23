import { AdmissionStatus, BedStatus, Prisma, Role } from "@prisma/client";
import { Router, type Response } from "express";
import { z } from "zod";
import { auditLogData, requireAuth, requireRole, type AuthenticatedRequest } from "./auth.js";
import { prisma } from "./db.js";
import { enqueuePortalNotification, processOutboxTree } from "./reliable-events.js";

export const dischargeRouter = Router();

const staffRoles = [Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN, Role.DOCTOR, Role.NURSE] as const;
const checklistRoles = [Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN, Role.DOCTOR, Role.NURSE] as const;
const checklistInclude = {
  approvedBy: { select: { id: true, name: true } },
  items: {
    include: {
      createdBy: { select: { id: true, name: true } },
      completedBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "asc" as const },
  },
};

function fail(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message } });
}

async function doctorDepartment(userId: string) {
  return prisma.doctor.findUnique({ where: { userId }, select: { departmentId: true } });
}

async function finalizeWhenReady(
  tx: Prisma.TransactionClient,
  req: AuthenticatedRequest,
  checklistId: string,
) {
  const checklist = await tx.dischargeChecklist.findUnique({
    where: { id: checklistId },
    include: { admission: { include: { patient: { select: { departmentId: true } } } }, items: true },
  });
  if (!checklist || checklist.admission.status !== AdmissionStatus.ACTIVE || !checklist.approvedAt) return null;
  if (!checklist.items.length || checklist.items.some((item) => !item.completedAt)) return null;

  const changed = await tx.admission.updateMany({
    where: { id: checklist.admissionId, status: AdmissionStatus.ACTIVE },
    data: { status: AdmissionStatus.DISCHARGED, dischargedAt: new Date() },
  });
  if (changed.count !== 1) return null;

  const remainingAdmissions = await tx.admission.count({
    where: { bedId: checklist.admission.bedId, status: AdmissionStatus.ACTIVE },
  });
  if (remainingAdmissions === 0) {
    const released = await tx.bed.updateMany({
      where: { id: checklist.admission.bedId, status: BedStatus.OCCUPIED },
      data: { status: BedStatus.AVAILABLE },
    });
    if (released.count !== 1) throw new Error("The admission bed was not occupied while finalizing discharge.");
  }
  await tx.dischargeChecklist.update({
    where: { id: checklist.id },
    data: { finalizedAt: new Date() },
  });
  await tx.auditLog.create({
    data: auditLogData(req, {
      action: "FINALIZE_DISCHARGE",
      entity: "ADMISSION",
      entityId: checklist.admissionId,
      metadata: { checklistItemCount: checklist.items.length },
    }),
  });
  const eventId = await enqueuePortalNotification(tx, {
    idempotencyKey: `discharge-finalized:${checklist.admissionId}`,
    patientId: checklist.admission.patientId,
    category: "DISCHARGE",
    title: "Discharge finalized",
    message: "Your hospital discharge has been finalized. Sign in to view your portal.",
    notifyStaff: true,
  });
  return eventId;
}

async function getChecklistAccess(
  req: AuthenticatedRequest,
  admissionId: string,
): Promise<{ admission: { id: string }; error?: never } | { error: "DOCTOR_PROFILE_REQUIRED" | "ADMISSION_NOT_FOUND"; admission?: never }> {
  const departmentId = req.auth!.role === Role.DOCTOR
    ? (await doctorDepartment(req.auth!.userId))?.departmentId
    : undefined;
  if (req.auth!.role === Role.DOCTOR && !departmentId) return { error: "DOCTOR_PROFILE_REQUIRED" as const };
  const admission = await prisma.admission.findFirst({
    where: {
      id: admissionId,
      ...(departmentId ? { patient: { departmentId } } : {}),
    },
    select: { id: true },
  });
  return admission ? { admission } : { error: "ADMISSION_NOT_FOUND" as const };
}

dischargeRouter.get("/admissions/:id/discharge-checklist", requireAuth, requireRole(...staffRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const access = await getChecklistAccess(req, String(req.params.id));
    if (access.error) {
      return access.error === "DOCTOR_PROFILE_REQUIRED"
        ? fail(res, 403, access.error, "A doctor profile is required for this resource.")
        : fail(res, 404, access.error, "The admission was not found.");
    }
    const checklist = await prisma.dischargeChecklist.findUnique({
      where: { admissionId: access.admission.id },
      include: checklistInclude,
    });
    res.json({ data: checklist });
  } catch (error) {
    next(error);
  }
});

dischargeRouter.post("/admissions/:id/discharge-checklist/items", requireAuth, requireRole(...checklistRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ label: z.string().trim().min(1).max(200) }).parse(req.body);
    const departmentId = req.auth!.role === Role.DOCTOR
      ? (await doctorDepartment(req.auth!.userId))?.departmentId
      : undefined;
    if (req.auth!.role === Role.DOCTOR && !departmentId) {
      return fail(res, 403, "DOCTOR_PROFILE_REQUIRED", "A doctor profile is required for this resource.");
    }
    const result = await prisma.$transaction(async (tx) => {
      const admission = await tx.admission.findFirst({
        where: {
          id: String(req.params.id),
          status: AdmissionStatus.ACTIVE,
          ...(departmentId ? { patient: { departmentId } } : {}),
        },
        select: { id: true },
      });
      if (!admission) return { kind: "not_found" as const };
      const checklist = await tx.dischargeChecklist.upsert({
        where: { admissionId: admission.id },
        create: { admissionId: admission.id },
        update: {},
        select: { id: true, approvedAt: true, finalizedAt: true },
      });
      if (checklist.approvedAt || checklist.finalizedAt) return { kind: "locked" as const };
      const item = await tx.dischargeChecklistItem.create({
        data: { checklistId: checklist.id, label: input.label, createdById: req.auth!.userId },
        include: { createdBy: { select: { id: true, name: true } } },
      });
      await tx.auditLog.create({
        data: auditLogData(req, { action: "ADD_CHECKLIST_ITEM", entity: "DISCHARGE_CHECKLIST", entityId: checklist.id, metadata: { itemId: item.id } }),
      });
      return { kind: "created" as const, item };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (result.kind === "not_found") return fail(res, 404, "ACTIVE_ADMISSION_NOT_FOUND", "An active admission was not found.");
    if (result.kind === "locked") return fail(res, 409, "DISCHARGE_CHECKLIST_LOCKED", "The checklist cannot be changed after clinician approval.");
    res.status(201).json({ data: result.item });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return fail(res, 409, "DISCHARGE_CHECKLIST_CHANGED", "The discharge checklist changed before this update was applied.");
    }
    next(error);
  }
});

dischargeRouter.patch("/admissions/:id/discharge-checklist/items/:itemId", requireAuth, requireRole(...checklistRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ completed: z.boolean() }).parse(req.body);
    const departmentId = req.auth!.role === Role.DOCTOR
      ? (await doctorDepartment(req.auth!.userId))?.departmentId
      : undefined;
    if (req.auth!.role === Role.DOCTOR && !departmentId) {
      return fail(res, 403, "DOCTOR_PROFILE_REQUIRED", "A doctor profile is required for this resource.");
    }
    const result = await prisma.$transaction(async (tx) => {
      const checklist = await tx.dischargeChecklist.findFirst({
        where: {
          admissionId: String(req.params.id),
          admission: {
            status: AdmissionStatus.ACTIVE,
            ...(departmentId ? { patient: { departmentId } } : {}),
          },
        },
        select: { id: true, finalizedAt: true },
      });
      if (!checklist) return { kind: "not_found" as const };
      if (checklist.finalizedAt) return { kind: "finalized" as const };
      const item = await tx.dischargeChecklistItem.findFirst({
        where: { id: String(req.params.itemId), checklistId: checklist.id },
        select: { id: true, completedAt: true },
      });
      if (!item) return { kind: "item_not_found" as const };
      const completedAt = input.completed ? new Date() : null;
      const changed = await tx.dischargeChecklistItem.updateMany({
        where: { id: item.id, checklistId: checklist.id, completedAt: item.completedAt },
        data: { completedAt, completedById: input.completed ? req.auth!.userId : null },
      });
      if (changed.count !== 1) return { kind: "changed" as const };
      await tx.auditLog.create({
        data: auditLogData(req, {
          action: input.completed ? "COMPLETE_CHECKLIST_ITEM" : "REOPEN_CHECKLIST_ITEM",
          entity: "DISCHARGE_CHECKLIST",
          entityId: checklist.id,
          metadata: { itemId: item.id },
        }),
      });
      const eventId = await finalizeWhenReady(tx, req, checklist.id);
      return { kind: "updated" as const, eventId };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (result.kind === "not_found") return fail(res, 404, "ACTIVE_ADMISSION_NOT_FOUND", "An active admission was not found.");
    if (result.kind === "finalized") return fail(res, 409, "DISCHARGE_ALREADY_FINALIZED", "The discharge has already been finalized.");
    if (result.kind === "item_not_found") return fail(res, 404, "CHECKLIST_ITEM_NOT_FOUND", "The checklist item was not found.");
    if (result.kind === "changed") return fail(res, 409, "CHECKLIST_ITEM_CHANGED", "The checklist item changed before this update was applied.");
    if (result.eventId) await processOutboxTree(result.eventId);
    const checklist = await prisma.dischargeChecklist.findUnique({
      where: { admissionId: String(req.params.id) },
      include: checklistInclude,
    });
    res.json({ data: checklist });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return fail(res, 409, "DISCHARGE_CHECKLIST_CHANGED", "The discharge checklist changed before this update was applied.");
    }
    next(error);
  }
});

dischargeRouter.post("/admissions/:id/discharge-checklist/approve", requireAuth, requireRole(Role.DOCTOR), async (req: AuthenticatedRequest, res, next) => {
  try {
    const department = await doctorDepartment(req.auth!.userId);
    if (!department) return fail(res, 403, "DOCTOR_PROFILE_REQUIRED", "A doctor profile is required for this resource.");
    const result = await prisma.$transaction(async (tx) => {
      const admission = await tx.admission.findFirst({
        where: {
          id: String(req.params.id),
          status: AdmissionStatus.ACTIVE,
          patient: { departmentId: department.departmentId },
        },
        select: { id: true },
      });
      if (!admission) return { kind: "not_found" as const };
      const checklist = await tx.dischargeChecklist.findUnique({
        where: { admissionId: admission.id },
        include: { items: { select: { id: true, completedAt: true } } },
      });
      if (!checklist || !checklist.items.length) return { kind: "items_required" as const };
      if (checklist.approvedAt || checklist.finalizedAt) return { kind: "already_approved" as const };
      const approvedAt = new Date();
      await tx.dischargeChecklist.update({
        where: { id: checklist.id },
        data: { approvedById: req.auth!.userId, approvedAt },
      });
      await tx.auditLog.create({
        data: auditLogData(req, {
          action: "APPROVE_DISCHARGE",
          entity: "DISCHARGE_CHECKLIST",
          entityId: checklist.id,
          metadata: { checklistItemCount: checklist.items.length },
        }),
      });
      const eventId = await finalizeWhenReady(tx, req, checklist.id);
      return { kind: "approved" as const, checklistId: checklist.id, eventId };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (result.kind === "not_found") return fail(res, 404, "ACTIVE_ADMISSION_NOT_FOUND", "An active admission was not found.");
    if (result.kind === "items_required") return fail(res, 409, "DISCHARGE_CHECKLIST_REQUIRED", "Add at least one checklist item before clinician approval.");
    if (result.kind === "already_approved") return fail(res, 409, "DISCHARGE_ALREADY_APPROVED", "The discharge checklist has already been approved.");
    if (result.eventId) await processOutboxTree(result.eventId);
    const checklist = await prisma.dischargeChecklist.findUnique({
      where: { id: result.checklistId },
      include: checklistInclude,
    });
    res.json({ data: checklist });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return fail(res, 409, "DISCHARGE_CHECKLIST_CHANGED", "The discharge checklist changed before this update was applied.");
    }
    next(error);
  }
});
