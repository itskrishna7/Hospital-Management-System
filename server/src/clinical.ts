import { Router, type Response } from "express";
import {
  ClinicalFieldType,
  ClinicalRecordStatus,
  ClinicalRecordType,
  EmergencyVisitStatus,
  NursingTaskStatus,
  PrescriptionStatus,
  Prisma,
  Role,
} from "@prisma/client";
import { z } from "zod";
import { auditLogData, requireAuth, requireRole, type AuthenticatedRequest } from "./auth.js";
import { prisma } from "./db.js";

export const clinicalRouter = Router();

const administrators = [Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN] as const;
const clinicalReaders = [Role.DOCTOR, Role.NURSE] as const;
const pharmacyUsers = [Role.DOCTOR, Role.PHARMACIST] as const;
const clinicalRecordTypes = Object.values(ClinicalRecordType);
const selectFieldTypes: ClinicalFieldType[] = [ClinicalFieldType.SINGLE_SELECT, ClinicalFieldType.MULTI_SELECT];

function clinicalError(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message } });
}

async function doctorDepartment(userId: string) {
  return prisma.doctor.findUnique({ where: { userId }, select: { departmentId: true } });
}

export async function patientIsAccessible(userId: string, role: Role, patientId: string, requireActiveAdmission = true) {
  if (role === Role.DOCTOR) {
    const doctor = await doctorDepartment(userId);
    if (!doctor) return "DOCTOR_PROFILE_REQUIRED";
    const patient = await prisma.patient.findFirst({ where: { id: patientId, departmentId: doctor.departmentId }, select: { id: true } });
    return patient ? "ALLOWED" : "NOT_FOUND";
  }
  if (role === Role.NURSE && requireActiveAdmission) {
    const patient = await prisma.patient.findFirst({
      where: { id: patientId, admissions: { some: { status: "ACTIVE" } } },
      select: { id: true },
    });
    return patient ? "ALLOWED" : "NOT_FOUND";
  }
  const patient = await prisma.patient.findUnique({ where: { id: patientId }, select: { id: true } });
  return patient ? "ALLOWED" : "NOT_FOUND";
}

function canAuthorRecord(role: Role, type: ClinicalRecordType) {
  if (type === ClinicalRecordType.NURSING_NOTE) return role === Role.NURSE;
  if (type === ClinicalRecordType.TRIAGE_NOTE) return role === Role.NURSE || role === Role.DOCTOR;
  return role === Role.DOCTOR;
}

function jsonInput(value: Record<string, unknown>): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

async function validateStructuredData(type: ClinicalRecordType, data: Record<string, unknown>) {
  const fields = await prisma.clinicalFieldDefinition.findMany({
    where: { active: true, OR: [{ appliesTo: { has: type } }, { appliesTo: { isEmpty: true } }] },
    select: { key: true, type: true, options: true, required: true },
  });
  const definitions = new Map(fields.map((field) => [field.key, field]));
  for (const [key, value] of Object.entries(data)) {
    const field = definitions.get(key);
    if (!field) return `The field "${key}" is not configured for this record type.`;
    const valid = (() => {
      switch (field.type) {
        case ClinicalFieldType.TEXT:
          return typeof value === "string" && value.length <= 4000;
        case ClinicalFieldType.NUMBER:
          return typeof value === "number" && Number.isFinite(value);
        case ClinicalFieldType.BOOLEAN:
          return typeof value === "boolean";
        case ClinicalFieldType.DATE:
          return typeof value === "string" && Number.isFinite(Date.parse(value));
        case ClinicalFieldType.SINGLE_SELECT:
          return typeof value === "string" && field.options.includes(value);
        case ClinicalFieldType.MULTI_SELECT:
          return Array.isArray(value) && value.every((item) => typeof item === "string" && field.options.includes(item));
      }
    })();
    if (!valid) return `The value for "${key}" does not match its configured field type.`;
  }
  const missing = fields.find((field) => field.required && !Object.hasOwn(data, field.key));
  return missing ? `The field "${missing.key}" is required.` : null;
}

async function validatePatientLinks(input: {
  patientId: string;
  appointmentId?: string;
  admissionId?: string;
  emergencyVisitId?: string;
}, userId: string, role: Role) {
  if (input.appointmentId) {
    const appointment = await prisma.appointment.findFirst({
      where: {
        id: input.appointmentId,
        patientId: input.patientId,
        ...(role === Role.DOCTOR ? { doctor: { userId } } : {}),
      },
      select: { id: true },
    });
    if (!appointment) return "The selected appointment is unavailable for this patient.";
  }
  if (input.admissionId) {
    const admission = await prisma.admission.findFirst({
      where: { id: input.admissionId, patientId: input.patientId, status: "ACTIVE" },
      select: { id: true },
    });
    if (!admission) return "The selected active admission is unavailable for this patient.";
  }
  if (input.emergencyVisitId) {
    const visit = await prisma.emergencyVisit.findFirst({
      where: { id: input.emergencyVisitId, patientId: input.patientId },
      select: { id: true },
    });
    if (!visit) return "The selected emergency visit is unavailable for this patient.";
  }
  return null;
}

const fieldDefinitionInput = z.object({
  key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,62}$/),
  label: z.string().trim().min(1).max(120),
  type: z.nativeEnum(ClinicalFieldType),
  appliesTo: z.array(z.nativeEnum(ClinicalRecordType)).max(clinicalRecordTypes.length).default([]),
  options: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
  required: z.boolean().default(false),
});

clinicalRouter.get("/clinical/fields", requireAuth, requireRole(...clinicalReaders, ...administrators), async (req: AuthenticatedRequest, res, next) => {
  try {
    const includeInactive = req.query.includeInactive === "true" && administrators.includes(req.auth!.role as (typeof administrators)[number]);
    const fields = await prisma.clinicalFieldDefinition.findMany({
      where: includeInactive ? undefined : { active: true },
      orderBy: [{ label: "asc" }],
    });
    res.json({ data: fields });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.post("/clinical/fields", requireAuth, requireRole(...administrators), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = fieldDefinitionInput.parse(req.body);
    if (selectFieldTypes.includes(input.type) && input.options.length === 0) {
      return clinicalError(res, 400, "FIELD_OPTIONS_REQUIRED", "Select fields require at least one configured option.");
    }
    const field = await prisma.$transaction(async (tx) => {
      const created = await tx.clinicalFieldDefinition.create({
        data: { ...input, createdById: req.auth!.userId },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE", entity: "CLINICAL_FIELD", entityId: created.id, metadata: { key: created.key, type: created.type } }) });
      return created;
    });
    res.status(201).json({ data: field });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.patch("/clinical/fields/:id", requireAuth, requireRole(...administrators), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      label: z.string().trim().min(1).max(120).optional(),
      options: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
      required: z.boolean().optional(),
      active: z.boolean().optional(),
    }).parse(req.body);
    const current = await prisma.clinicalFieldDefinition.findUnique({ where: { id: String(req.params.id) } });
    if (!current) return clinicalError(res, 404, "CLINICAL_FIELD_NOT_FOUND", "The clinical field was not found.");
    const options = input.options ?? current.options;
    if (selectFieldTypes.includes(current.type) && options.length === 0 && current.active) {
      return clinicalError(res, 400, "FIELD_OPTIONS_REQUIRED", "Select fields require at least one configured option.");
    }
    const field = await prisma.$transaction(async (tx) => {
      const updated = await tx.clinicalFieldDefinition.update({ where: { id: current.id }, data: input });
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE", entity: "CLINICAL_FIELD", entityId: updated.id, metadata: { key: updated.key } }) });
      return updated;
    });
    res.json({ data: field });
  } catch (error) {
    next(error);
  }
});

const clinicalRecordInput = z.object({
  patientId: z.string().min(1),
  type: z.nativeEnum(ClinicalRecordType),
  title: z.string().trim().min(1).max(160),
  narrative: z.string().max(20_000).optional(),
  structuredData: z.record(z.string(), z.unknown()).default({}),
  appointmentId: z.string().optional(),
  admissionId: z.string().optional(),
  emergencyVisitId: z.string().optional(),
});

clinicalRouter.get("/clinical/records", requireAuth, requireRole(...clinicalReaders), async (req: AuthenticatedRequest, res, next) => {
  try {
    const query = z.object({
      patientId: z.string().min(1),
      type: z.nativeEnum(ClinicalRecordType).optional(),
    }).parse(req.query);
    const access = await patientIsAccessible(req.auth!.userId, req.auth!.role, query.patientId, query.type !== ClinicalRecordType.TRIAGE_NOTE);
    if (access === "DOCTOR_PROFILE_REQUIRED") return clinicalError(res, 403, access, "A doctor profile is required for this resource.");
    if (access !== "ALLOWED") return clinicalError(res, 404, "PATIENT_NOT_FOUND", "The requested patient was not found.");
    const records = await prisma.clinicalRecord.findMany({
      where: { patientId: query.patientId, ...(query.type ? { type: query.type } : {}) },
      include: {
        authoredBy: { select: { id: true, name: true, role: true } },
        signedBy: { select: { id: true, name: true, role: true } },
      },
      orderBy: [{ createdAt: "desc" }, { version: "desc" }],
    });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "CLINICAL_RECORD", metadata: { patientId: query.patientId, recordCount: records.length } }) });
    res.json({ data: records });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.post("/clinical/records", requireAuth, requireRole(...clinicalReaders), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = clinicalRecordInput.parse(req.body);
    if (!canAuthorRecord(req.auth!.role, input.type)) {
      return clinicalError(res, 403, "CLINICAL_AUTHOR_FORBIDDEN", "Your clinical role cannot author this record type.");
    }
    const access = await patientIsAccessible(req.auth!.userId, req.auth!.role, input.patientId, input.type === ClinicalRecordType.NURSING_NOTE);
    if (access === "DOCTOR_PROFILE_REQUIRED") return clinicalError(res, 403, access, "A doctor profile is required for this resource.");
    if (access !== "ALLOWED") return clinicalError(res, 404, "PATIENT_NOT_FOUND", "The requested patient was not found or is outside your clinical scope.");
    const linkError = await validatePatientLinks(input, req.auth!.userId, req.auth!.role);
    if (linkError) return clinicalError(res, 400, "INVALID_CLINICAL_LINK", linkError);
    const dataError = await validateStructuredData(input.type, input.structuredData);
    if (dataError) return clinicalError(res, 400, "INVALID_CLINICAL_FIELDS", dataError);
    const record = await prisma.$transaction(async (tx) => {
      const created = await tx.clinicalRecord.create({
        data: {
          ...input,
          structuredData: jsonInput(input.structuredData),
          authoredById: req.auth!.userId,
        },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE_DRAFT", entity: "CLINICAL_RECORD", entityId: created.id, metadata: { recordType: created.type, version: created.version } }) });
      return created;
    });
    res.status(201).json({ data: record });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.patch("/clinical/records/:id", requireAuth, requireRole(...clinicalReaders), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      title: z.string().trim().min(1).max(160),
      narrative: z.string().max(20_000).optional(),
      structuredData: z.record(z.string(), z.unknown()).default({}),
    }).parse(req.body);
    const current = await prisma.clinicalRecord.findUnique({ where: { id: String(req.params.id) } });
    if (!current) return clinicalError(res, 404, "CLINICAL_RECORD_NOT_FOUND", "The clinical record was not found.");
    if (current.status !== ClinicalRecordStatus.DRAFT || current.authoredById !== req.auth!.userId) {
      return clinicalError(res, 409, "CLINICAL_RECORD_IMMUTABLE", "Only the author may revise their current draft; signed records require a formal amendment.");
    }
    if (!canAuthorRecord(req.auth!.role, current.type)) return clinicalError(res, 403, "CLINICAL_AUTHOR_FORBIDDEN", "Your clinical role cannot revise this record type.");
    const access = await patientIsAccessible(req.auth!.userId, req.auth!.role, current.patientId, current.type === ClinicalRecordType.NURSING_NOTE);
    if (access !== "ALLOWED") return clinicalError(res, access === "DOCTOR_PROFILE_REQUIRED" ? 403 : 404, access, "The patient is outside your clinical scope.");
    const dataError = await validateStructuredData(current.type, input.structuredData);
    if (dataError) return clinicalError(res, 400, "INVALID_CLINICAL_FIELDS", dataError);
    const result = await prisma.$transaction(async (tx) => {
      const superseded = await tx.clinicalRecord.updateMany({
        where: { id: current.id, status: ClinicalRecordStatus.DRAFT, version: current.version },
        data: { status: ClinicalRecordStatus.SUPERSEDED },
      });
      if (superseded.count !== 1) return null;
      const created = await tx.clinicalRecord.create({
        data: {
          patientId: current.patientId,
          type: current.type,
          version: current.version + 1,
          title: input.title,
          narrative: input.narrative,
          structuredData: jsonInput(input.structuredData),
          authoredById: req.auth!.userId,
          previousVersionId: current.id,
          revisionReason: "Draft revision",
          appointmentId: current.appointmentId,
          admissionId: current.admissionId,
          emergencyVisitId: current.emergencyVisitId,
        },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE_VERSION", entity: "CLINICAL_RECORD", entityId: created.id, metadata: { previousVersionId: current.id, version: created.version } }) });
      return created;
    });
    if (!result) return clinicalError(res, 409, "CLINICAL_RECORD_IMMUTABLE", "The draft has already changed or been signed.");
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.post("/clinical/records/:id/sign", requireAuth, requireRole(...clinicalReaders), async (req: AuthenticatedRequest, res, next) => {
  try {
    const confirmation = z.object({ reviewConfirmed: z.literal(true) }).parse(req.body);
    const record = await prisma.clinicalRecord.findUnique({ where: { id: String(req.params.id) } });
    if (!record) return clinicalError(res, 404, "CLINICAL_RECORD_NOT_FOUND", "The clinical record was not found.");
    const access = await patientIsAccessible(req.auth!.userId, req.auth!.role, record.patientId, record.type === ClinicalRecordType.NURSING_NOTE);
    if (access !== "ALLOWED") return clinicalError(res, access === "DOCTOR_PROFILE_REQUIRED" ? 403 : 404, access, "The patient is outside your clinical scope.");
    if (!canAuthorRecord(req.auth!.role, record.type) || record.authoredById !== req.auth!.userId) {
      return clinicalError(res, 403, "CLINICAL_SIGN_FORBIDDEN", "Only the authorized author may sign this record.");
    }
    if (record.status !== ClinicalRecordStatus.DRAFT) {
      return clinicalError(res, 409, "CLINICAL_RECORD_IMMUTABLE", "Only an unsigned draft can be signed.");
    }
    const signed = await prisma.$transaction(async (tx) => {
      const updated = await tx.clinicalRecord.updateMany({
        where: { id: record.id, authoredById: req.auth!.userId, status: ClinicalRecordStatus.DRAFT },
        data: { status: ClinicalRecordStatus.SIGNED, signedById: req.auth!.userId, signedAt: new Date() },
      });
      if (updated.count !== 1) return null;
      const result = await tx.clinicalRecord.findUniqueOrThrow({ where: { id: record.id } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "SIGN", entity: "CLINICAL_RECORD", entityId: result.id, metadata: { recordType: result.type, version: result.version, reviewConfirmed: confirmation.reviewConfirmed } }) });
      return result;
    });
    if (!signed) return clinicalError(res, 409, "CLINICAL_RECORD_IMMUTABLE", "The draft has already changed or been signed.");
    res.json({ data: signed });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.post("/clinical/records/:id/amend", requireAuth, requireRole(...clinicalReaders), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      reason: z.string().trim().min(10).max(500),
      title: z.string().trim().min(1).max(160).optional(),
      narrative: z.string().max(20_000).optional(),
      structuredData: z.record(z.string(), z.unknown()).optional(),
    }).parse(req.body);
    const previous = await prisma.clinicalRecord.findUnique({ where: { id: String(req.params.id) } });
    if (!previous) return clinicalError(res, 404, "CLINICAL_RECORD_NOT_FOUND", "The clinical record was not found.");
    const access = await patientIsAccessible(req.auth!.userId, req.auth!.role, previous.patientId, previous.type === ClinicalRecordType.NURSING_NOTE);
    if (access !== "ALLOWED") return clinicalError(res, access === "DOCTOR_PROFILE_REQUIRED" ? 403 : 404, access, "The patient is outside your clinical scope.");
    if (!canAuthorRecord(req.auth!.role, previous.type) || previous.authoredById !== req.auth!.userId) {
      return clinicalError(res, 403, "CLINICAL_AMENDMENT_FORBIDDEN", "Only the authorized original author may amend this record.");
    }
    if (previous.status !== ClinicalRecordStatus.SIGNED) {
      return clinicalError(res, 409, "CLINICAL_AMENDMENT_FORBIDDEN", "Only a signed record may be amended.");
    }
    const data = input.structuredData ?? (previous.structuredData as Record<string, unknown>);
    const dataError = await validateStructuredData(previous.type, data);
    if (dataError) return clinicalError(res, 400, "INVALID_CLINICAL_FIELDS", dataError);
    const amendment = await prisma.$transaction(async (tx) => {
      const created = await tx.clinicalRecord.create({
        data: {
          patientId: previous.patientId,
          type: previous.type,
          version: previous.version + 1,
          title: input.title ?? previous.title,
          narrative: input.narrative ?? previous.narrative,
          structuredData: jsonInput(data),
          authoredById: req.auth!.userId,
          previousVersionId: previous.id,
          revisionReason: input.reason,
          appointmentId: previous.appointmentId,
          admissionId: previous.admissionId,
          emergencyVisitId: previous.emergencyVisitId,
        },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "AMEND", entity: "CLINICAL_RECORD", entityId: created.id, metadata: { previousVersionId: previous.id, version: created.version } }) });
      return created;
    });
    res.status(201).json({ data: amendment });
  } catch (error) {
    next(error);
  }
});

const medicineOptions = z.array(z.string().trim().min(1).max(120)).min(1).max(100);
const formularyInput = z.object({
  name: z.string().trim().min(1).max(160),
  sku: z.string().trim().min(1).max(80),
  expiresAt: z.coerce.date(),
  dosageForms: medicineOptions,
  strengths: medicineOptions,
  routes: medicineOptions,
  reorderLevel: z.number().int().min(0).max(1_000_000).default(10),
});

clinicalRouter.get("/formulary", requireAuth, requireRole(Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.PHARMACIST), async (req: AuthenticatedRequest, res, next) => {
  try {
    const canConfigure = administrators.includes(req.auth!.role as (typeof administrators)[number]) || req.auth!.role === Role.PHARMACIST;
    const includeDisabled = req.query.includeDisabled === "true" && canConfigure;
    const medicines = await prisma.medicine.findMany({
      where: includeDisabled ? undefined : { formularyEnabled: true },
      select: { id: true, name: true, sku: true, dosageForms: true, strengths: true, routes: true, formularyEnabled: true },
      orderBy: { name: "asc" },
    });
    res.json({ data: medicines });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.post("/formulary", requireAuth, requireRole(Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN, Role.PHARMACIST), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = formularyInput.parse(req.body);
    if (input.expiresAt <= new Date()) return clinicalError(res, 400, "INVALID_EXPIRY", "The inventory expiry date must be in the future.");
    const medicine = await prisma.$transaction(async (tx) => {
      const created = await tx.medicine.create({
        data: { ...input, quantity: 0, formularyEnabled: true },
        select: { id: true, name: true, sku: true, dosageForms: true, strengths: true, routes: true, formularyEnabled: true },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE", entity: "FORMULARY_MEDICATION", entityId: created.id, metadata: { sku: created.sku } }) });
      return created;
    });
    res.status(201).json({ data: medicine });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.patch("/formulary/:id", requireAuth, requireRole(Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN, Role.PHARMACIST), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      dosageForms: medicineOptions.optional(),
      strengths: medicineOptions.optional(),
      routes: medicineOptions.optional(),
      formularyEnabled: z.boolean().optional(),
    }).parse(req.body);
    const current = await prisma.medicine.findUnique({ where: { id: String(req.params.id) } });
    if (!current) return clinicalError(res, 404, "MEDICATION_NOT_FOUND", "The medication was not found.");
    const options = {
      dosageForms: input.dosageForms ?? current.dosageForms,
      strengths: input.strengths ?? current.strengths,
      routes: input.routes ?? current.routes,
    };
    if (input.formularyEnabled !== false && (!options.dosageForms.length || !options.strengths.length || !options.routes.length)) {
      return clinicalError(res, 400, "FORMULARY_OPTIONS_REQUIRED", "Configure dosage forms, strengths, and routes before enabling a medication.");
    }
    const medicine = await prisma.$transaction(async (tx) => {
      const updated = await tx.medicine.update({
        where: { id: current.id },
        data: input,
        select: { id: true, name: true, sku: true, dosageForms: true, strengths: true, routes: true, formularyEnabled: true },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE", entity: "FORMULARY_MEDICATION", entityId: updated.id, metadata: { enabled: updated.formularyEnabled } }) });
      return updated;
    });
    res.json({ data: medicine });
  } catch (error) {
    next(error);
  }
});

const prescriptionItemInput = z.object({
  medicineId: z.string().min(1),
  dose: z.string().trim().min(1).max(120),
  strength: z.string().trim().min(1).max(120),
  dosageForm: z.string().trim().min(1).max(120),
  route: z.string().trim().min(1).max(120),
  frequency: z.string().trim().min(1).max(160),
  duration: z.string().trim().min(1).max(120).optional(),
  quantity: z.number().int().positive().max(100_000),
  instructions: z.string().trim().max(1000).optional(),
});

const prescriptionInput = z.object({
  patientId: z.string().min(1),
  clinicalRecordId: z.string().min(1).optional(),
  items: z.array(prescriptionItemInput).min(1).max(50),
});

async function validatePrescriptionItems(items: ReadonlyArray<{
  medicineId: string;
  strength: string | null | undefined;
  dosageForm: string | null | undefined;
  route: string;
}>) {
  const medicines = await prisma.medicine.findMany({
    where: { id: { in: [...new Set(items.map((item) => item.medicineId))] }, formularyEnabled: true },
    select: { id: true, dosageForms: true, strengths: true, routes: true },
  });
  const byId = new Map(medicines.map((medicine) => [medicine.id, medicine]));
  for (const item of items) {
    const medicine = byId.get(item.medicineId);
    if (!medicine) return "Every prescription item must use an active formulary medication.";
    if (!item.dosageForm || !item.strength || !medicine.dosageForms.includes(item.dosageForm) || !medicine.strengths.includes(item.strength) || !medicine.routes.includes(item.route)) {
      return "Prescription form, strength, and route must match the configured formulary options.";
    }
  }
  return null;
}

clinicalRouter.get("/prescriptions", requireAuth, requireRole(Role.DOCTOR, Role.NURSE, Role.PHARMACIST), async (req: AuthenticatedRequest, res, next) => {
  try {
    const query = z.object({ patientId: z.string().min(1).optional() }).parse(req.query);
    const where: Prisma.PrescriptionWhereInput = {};
    if (req.auth!.role === Role.DOCTOR) {
      const doctor = await doctorDepartment(req.auth!.userId);
      if (!doctor) return clinicalError(res, 403, "DOCTOR_PROFILE_REQUIRED", "A doctor profile is required for this resource.");
      where.patient = { departmentId: doctor.departmentId };
    }
    if (req.auth!.role === Role.NURSE) where.patient = { admissions: { some: { status: "ACTIVE" } } };
    if (req.auth!.role === Role.PHARMACIST) where.status = PrescriptionStatus.SIGNED;
    if (query.patientId) {
      const access = await patientIsAccessible(req.auth!.userId, req.auth!.role, query.patientId, req.auth!.role === Role.NURSE);
      if (access === "DOCTOR_PROFILE_REQUIRED") return clinicalError(res, 403, access, "A doctor profile is required for this resource.");
      if (access !== "ALLOWED") return clinicalError(res, 404, "PATIENT_NOT_FOUND", "The requested patient was not found or is outside your clinical scope.");
      where.patientId = query.patientId;
    }
    if (req.auth!.role === Role.NURSE) where.status = PrescriptionStatus.SIGNED;
    const prescriptions = await prisma.prescription.findMany({
      where,
      include: {
        patient: { select: { id: true, patientNumber: true, firstName: true, lastName: true } },
        items: { include: { medicine: { select: { id: true, name: true, sku: true, dosageForms: true, strengths: true, routes: true } } } },
        prescribedBy: { select: { id: true, name: true } },
        signedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "PRESCRIPTION", metadata: { recordCount: prescriptions.length } }) });
    res.json({ data: prescriptions });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.post("/prescriptions", requireAuth, requireRole(Role.DOCTOR), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = prescriptionInput.parse(req.body);
    const doctor = await doctorDepartment(req.auth!.userId);
    if (!doctor) return clinicalError(res, 403, "DOCTOR_PROFILE_REQUIRED", "A doctor profile is required to prescribe.");
    const access = await patientIsAccessible(req.auth!.userId, req.auth!.role, input.patientId, false);
    if (access !== "ALLOWED") return clinicalError(res, 404, "PATIENT_NOT_FOUND", "The requested patient was not found or is outside your clinical scope.");
    if (input.clinicalRecordId) {
      const clinicalRecord = await prisma.clinicalRecord.findFirst({
        where: { id: input.clinicalRecordId, patientId: input.patientId, status: ClinicalRecordStatus.SIGNED, type: { in: [ClinicalRecordType.CONSULTATION, ClinicalRecordType.CARE_PLAN] } },
        select: { id: true },
      });
      if (!clinicalRecord) return clinicalError(res, 400, "SIGNED_CLINICAL_RECORD_REQUIRED", "A prescription may only link to a signed consultation or care-plan record for this patient.");
    }
    const formularyError = await validatePrescriptionItems(input.items);
    if (formularyError) return clinicalError(res, 400, "INVALID_FORMULARY_SELECTION", formularyError);
    const prescription = await prisma.$transaction(async (tx) => {
      const created = await tx.prescription.create({
        data: {
          patientId: input.patientId,
          clinicalRecordId: input.clinicalRecordId,
          prescribedById: req.auth!.userId,
          items: { create: input.items },
        },
        include: { items: { include: { medicine: { select: { id: true, name: true, sku: true } } } } },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE_DRAFT", entity: "PRESCRIPTION", entityId: created.id, metadata: { itemCount: created.items.length } }) });
      return created;
    });
    res.status(201).json({ data: prescription });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.patch("/prescriptions/:id", requireAuth, requireRole(Role.DOCTOR), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ items: z.array(prescriptionItemInput).min(1).max(50) }).parse(req.body);
    const prescription = await prisma.prescription.findUnique({
      where: { id: String(req.params.id) },
      include: { patient: { select: { departmentId: true } } },
    });
    if (!prescription) return clinicalError(res, 404, "PRESCRIPTION_NOT_FOUND", "The prescription was not found.");
    const doctor = await doctorDepartment(req.auth!.userId);
    if (!doctor) return clinicalError(res, 403, "DOCTOR_PROFILE_REQUIRED", "A doctor profile is required to revise prescriptions.");
    if (prescription.patient.departmentId !== doctor.departmentId) return clinicalError(res, 404, "PRESCRIPTION_NOT_FOUND", "The prescription was not found.");
    if (prescription.prescribedById !== req.auth!.userId || prescription.status !== PrescriptionStatus.DRAFT) {
      return clinicalError(res, 409, "PRESCRIPTION_IMMUTABLE", "Only the prescribing doctor may revise their current draft.");
    }
    const formularyError = await validatePrescriptionItems(input.items);
    if (formularyError) return clinicalError(res, 400, "INVALID_FORMULARY_SELECTION", formularyError);
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.prescription.updateMany({
        where: { id: prescription.id, prescribedById: req.auth!.userId, status: PrescriptionStatus.DRAFT },
        data: { status: PrescriptionStatus.DRAFT },
      });
      if (current.count !== 1) return null;
      await tx.prescriptionItem.deleteMany({ where: { prescriptionId: prescription.id } });
      await tx.prescriptionItem.createMany({ data: input.items.map((item) => ({ ...item, prescriptionId: prescription.id })) });
      const result = await tx.prescription.findUniqueOrThrow({ where: { id: prescription.id }, include: { items: true } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE_DRAFT", entity: "PRESCRIPTION", entityId: result.id, metadata: { itemCount: result.items.length } }) });
      return result;
    });
    if (!updated) return clinicalError(res, 409, "PRESCRIPTION_IMMUTABLE", "The prescription has already changed.");
    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.post("/prescriptions/:id/sign", requireAuth, requireRole(Role.DOCTOR), async (req: AuthenticatedRequest, res, next) => {
  try {
    const confirmation = z.object({ reviewConfirmed: z.literal(true) }).parse(req.body);
    const prescription = await prisma.prescription.findUnique({
      where: { id: String(req.params.id) },
      include: { patient: { select: { departmentId: true } }, items: true },
    });
    if (!prescription) return clinicalError(res, 404, "PRESCRIPTION_NOT_FOUND", "The prescription was not found.");
    const doctor = await doctorDepartment(req.auth!.userId);
    if (!doctor) return clinicalError(res, 403, "DOCTOR_PROFILE_REQUIRED", "A doctor profile is required to authorize prescriptions.");
    if (prescription.patient.departmentId !== doctor.departmentId) return clinicalError(res, 404, "PRESCRIPTION_NOT_FOUND", "The prescription was not found.");
    if (prescription.prescribedById !== req.auth!.userId) {
      return clinicalError(res, 403, "PRESCRIPTION_SIGN_FORBIDDEN", "Only the prescribing doctor may sign this draft.");
    }
    if (prescription.status !== PrescriptionStatus.DRAFT) return clinicalError(res, 409, "PRESCRIPTION_IMMUTABLE", "Only a draft prescription can be signed.");
    const formularyError = await validatePrescriptionItems(prescription.items);
    if (formularyError) return clinicalError(res, 409, "FORMULARY_CHANGED", "The formulary configuration changed; review the prescription before signing.");
    const signed = await prisma.$transaction(async (tx) => {
      const changed = await tx.prescription.updateMany({
        where: { id: prescription.id, prescribedById: req.auth!.userId, status: PrescriptionStatus.DRAFT },
        data: { status: PrescriptionStatus.SIGNED, signedById: req.auth!.userId, signedAt: new Date() },
      });
      if (changed.count !== 1) return null;
      const result = await tx.prescription.findUniqueOrThrow({ where: { id: prescription.id }, include: { items: true } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "SIGN", entity: "PRESCRIPTION", entityId: result.id, metadata: { itemCount: result.items.length, reviewConfirmed: confirmation.reviewConfirmed } }) });
      return result;
    });
    if (!signed) return clinicalError(res, 409, "PRESCRIPTION_IMMUTABLE", "The prescription has already changed.");
    res.json({ data: signed });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.post("/prescriptions/:id/cancel", requireAuth, requireRole(Role.DOCTOR), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ reason: z.string().trim().min(10).max(500) }).parse(req.body);
    const prescription = await prisma.prescription.findUnique({ where: { id: String(req.params.id) }, select: { id: true, status: true, prescribedById: true, patient: { select: { departmentId: true } } } });
    if (!prescription) return clinicalError(res, 404, "PRESCRIPTION_NOT_FOUND", "The prescription was not found.");
    const doctor = await doctorDepartment(req.auth!.userId);
    if (!doctor) return clinicalError(res, 403, "DOCTOR_PROFILE_REQUIRED", "A doctor profile is required to cancel prescriptions.");
    if (prescription.patient.departmentId !== doctor.departmentId) return clinicalError(res, 404, "PRESCRIPTION_NOT_FOUND", "The prescription was not found.");
    if (prescription.prescribedById !== req.auth!.userId || prescription.status === PrescriptionStatus.CANCELLED) {
      return clinicalError(res, 409, "PRESCRIPTION_IMMUTABLE", "Only the prescribing doctor may cancel an active prescription.");
    }
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.prescription.updateMany({
        where: { id: prescription.id, prescribedById: req.auth!.userId, status: { in: [PrescriptionStatus.DRAFT, PrescriptionStatus.SIGNED] } },
        data: { status: PrescriptionStatus.CANCELLED },
      });
      if (updated.count !== 1) return null;
      const cancelled = await tx.prescription.findUniqueOrThrow({ where: { id: prescription.id } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CANCEL", entity: "PRESCRIPTION", entityId: cancelled.id, metadata: { reason: input.reason } }) });
      return cancelled;
    });
    if (!result) return clinicalError(res, 409, "PRESCRIPTION_IMMUTABLE", "The prescription has already changed.");
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.get("/nursing/tasks", requireAuth, requireRole(Role.DOCTOR, Role.NURSE), async (req: AuthenticatedRequest, res, next) => {
  try {
    const query = z.object({ patientId: z.string().min(1).optional() }).parse(req.query);
    const where: Prisma.NursingTaskWhereInput = {
      patient: { admissions: { some: { status: "ACTIVE" } } },
    };
    if (req.auth!.role === Role.DOCTOR) {
      const doctor = await doctorDepartment(req.auth!.userId);
      if (!doctor) return clinicalError(res, 403, "DOCTOR_PROFILE_REQUIRED", "A doctor profile is required for this resource.");
      where.patient = { departmentId: doctor.departmentId, admissions: { some: { status: "ACTIVE" } } };
    } else {
      where.OR = [{ assignedToId: req.auth!.userId }, { assignedToId: null }];
    }
    if (query.patientId) {
      const access = await patientIsAccessible(req.auth!.userId, req.auth!.role, query.patientId);
      if (access === "DOCTOR_PROFILE_REQUIRED") return clinicalError(res, 403, access, "A doctor profile is required for this resource.");
      if (access !== "ALLOWED") return clinicalError(res, 404, "PATIENT_NOT_FOUND", "The requested patient was not found or is outside your clinical scope.");
      where.patientId = query.patientId;
    }
    const tasks = await prisma.nursingTask.findMany({
      where,
      include: {
        patient: { select: { id: true, patientNumber: true, firstName: true, lastName: true } },
        assignedTo: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: [{ status: "asc" }, { dueAt: "asc" }, { createdAt: "desc" }],
    });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "NURSING_TASK", metadata: { recordCount: tasks.length } }) });
    res.json({ data: tasks });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.post("/nursing/tasks", requireAuth, requireRole(Role.DOCTOR, Role.NURSE), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      patientId: z.string().min(1),
      admissionId: z.string().min(1).optional(),
      title: z.string().trim().min(1).max(160),
      details: z.string().trim().max(4000).optional(),
      assignedToId: z.string().min(1).optional(),
      dueAt: z.coerce.date().optional(),
    }).parse(req.body);
    const access = await patientIsAccessible(req.auth!.userId, req.auth!.role, input.patientId, req.auth!.role === Role.NURSE);
    if (access === "DOCTOR_PROFILE_REQUIRED") return clinicalError(res, 403, access, "A doctor profile is required for this resource.");
    if (access !== "ALLOWED") return clinicalError(res, 404, "PATIENT_NOT_FOUND", "The requested patient was not found or is outside your clinical scope.");
    const activeAdmission = await prisma.admission.findFirst({
      where: { patientId: input.patientId, status: "ACTIVE", ...(input.admissionId ? { id: input.admissionId } : {}) },
      select: { id: true },
    });
    if (!activeAdmission) return clinicalError(res, 400, "ACTIVE_ADMISSION_REQUIRED", "Nursing tasks must be associated with an active admission.");
    if (input.assignedToId) {
      const assignee = await prisma.user.findFirst({ where: { id: input.assignedToId, role: Role.NURSE, active: true }, select: { id: true } });
      if (!assignee) return clinicalError(res, 400, "INVALID_NURSING_ASSIGNEE", "Tasks can only be assigned to an active nurse.");
    }
    const task = await prisma.$transaction(async (tx) => {
      const created = await tx.nursingTask.create({
        data: { ...input, admissionId: activeAdmission.id, createdById: req.auth!.userId },
        include: { patient: { select: { id: true, patientNumber: true, firstName: true, lastName: true } } },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE", entity: "NURSING_TASK", entityId: created.id }) });
      return created;
    });
    res.status(201).json({ data: task });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.patch("/nursing/tasks/:id/status", requireAuth, requireRole(Role.DOCTOR, Role.NURSE), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ status: z.nativeEnum(NursingTaskStatus) }).parse(req.body);
    const task = await prisma.nursingTask.findUnique({ where: { id: String(req.params.id) } });
    if (!task) return clinicalError(res, 404, "NURSING_TASK_NOT_FOUND", "The nursing task was not found.");
    const access = await patientIsAccessible(req.auth!.userId, req.auth!.role, task.patientId, req.auth!.role === Role.NURSE);
    if (access === "DOCTOR_PROFILE_REQUIRED") return clinicalError(res, 403, access, "A doctor profile is required for this resource.");
    if (access !== "ALLOWED") return clinicalError(res, 404, "NURSING_TASK_NOT_FOUND", "The nursing task was not found.");
    if (req.auth!.role === Role.NURSE && task.assignedToId && task.assignedToId !== req.auth!.userId) {
      return clinicalError(res, 403, "NURSING_TASK_FORBIDDEN", "The task is assigned to another nurse.");
    }
    const allowed: NursingTaskStatus[] = task.status === NursingTaskStatus.OPEN
      ? [NursingTaskStatus.IN_PROGRESS, NursingTaskStatus.CANCELLED]
      : task.status === NursingTaskStatus.IN_PROGRESS
        ? [NursingTaskStatus.COMPLETED, NursingTaskStatus.CANCELLED]
        : [];
    if (!allowed.includes(input.status)) return clinicalError(res, 409, "INVALID_NURSING_TASK_TRANSITION", "The requested task status transition is not allowed.");
    const result = await prisma.$transaction(async (tx) => {
      const changed = await tx.nursingTask.updateMany({
        where: { id: task.id, status: task.status },
        data: { status: input.status, completedAt: input.status === NursingTaskStatus.COMPLETED ? new Date() : null },
      });
      if (changed.count !== 1) return null;
      const updated = await tx.nursingTask.findUniqueOrThrow({ where: { id: task.id } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE_STATUS", entity: "NURSING_TASK", entityId: updated.id, metadata: { status: updated.status } }) });
      return updated;
    });
    if (!result) return clinicalError(res, 409, "NURSING_TASK_CHANGED", "The task changed before your update was applied.");
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.get("/nursing/handovers", requireAuth, requireRole(Role.DOCTOR, Role.NURSE), async (req: AuthenticatedRequest, res, next) => {
  try {
    const query = z.object({ patientId: z.string().min(1) }).parse(req.query);
    const access = await patientIsAccessible(req.auth!.userId, req.auth!.role, query.patientId, req.auth!.role === Role.NURSE);
    if (access === "DOCTOR_PROFILE_REQUIRED") return clinicalError(res, 403, access, "A doctor profile is required for this resource.");
    if (access !== "ALLOWED") return clinicalError(res, 404, "PATIENT_NOT_FOUND", "The requested patient was not found or is outside your clinical scope.");
    const handovers = await prisma.nursingHandover.findMany({
      where: { patientId: query.patientId },
      include: {
        sentBy: { select: { id: true, name: true } },
        receivedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "NURSING_HANDOVER", metadata: { patientId: query.patientId, recordCount: handovers.length } }) });
    res.json({ data: handovers });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.post("/nursing/handovers", requireAuth, requireRole(Role.NURSE), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      patientId: z.string().min(1),
      admissionId: z.string().min(1).optional(),
      summary: z.string().trim().min(1).max(5000),
      receivedById: z.string().min(1).optional(),
    }).parse(req.body);
    const access = await patientIsAccessible(req.auth!.userId, req.auth!.role, input.patientId);
    if (access !== "ALLOWED") return clinicalError(res, 404, "PATIENT_NOT_FOUND", "The requested patient was not found or does not have an active admission.");
    const admission = await prisma.admission.findFirst({
      where: { patientId: input.patientId, status: "ACTIVE", ...(input.admissionId ? { id: input.admissionId } : {}) },
      select: { id: true },
    });
    if (!admission) return clinicalError(res, 400, "ACTIVE_ADMISSION_REQUIRED", "A handover must be associated with an active admission.");
    if (input.receivedById) {
      const recipient = await prisma.user.findFirst({ where: { id: input.receivedById, role: Role.NURSE, active: true }, select: { id: true } });
      if (!recipient) return clinicalError(res, 400, "INVALID_HANDOVER_RECIPIENT", "The recipient must be an active nurse.");
    }
    const handover = await prisma.$transaction(async (tx) => {
      const created = await tx.nursingHandover.create({
        data: { ...input, admissionId: admission.id, sentById: req.auth!.userId },
        include: { sentBy: { select: { id: true, name: true } }, receivedBy: { select: { id: true, name: true } } },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE", entity: "NURSING_HANDOVER", entityId: created.id }) });
      return created;
    });
    res.status(201).json({ data: handover });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.get("/nursing/medication-administrations", requireAuth, requireRole(Role.DOCTOR, Role.NURSE), async (req: AuthenticatedRequest, res, next) => {
  try {
    const query = z.object({ patientId: z.string().min(1) }).parse(req.query);
    const access = await patientIsAccessible(req.auth!.userId, req.auth!.role, query.patientId, req.auth!.role === Role.NURSE);
    if (access === "DOCTOR_PROFILE_REQUIRED") return clinicalError(res, 403, access, "A doctor profile is required for this resource.");
    if (access !== "ALLOWED") return clinicalError(res, 404, "PATIENT_NOT_FOUND", "The requested patient was not found or is outside your clinical scope.");
    const administrations = await prisma.medicationAdministration.findMany({
      where: { patientId: query.patientId },
      include: {
        prescriptionItem: { include: { medicine: { select: { id: true, name: true } } } },
        administeredBy: { select: { id: true, name: true } },
      },
      orderBy: { administeredAt: "desc" },
    });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "MEDICATION_ADMINISTRATION", metadata: { patientId: query.patientId, recordCount: administrations.length } }) });
    res.json({ data: administrations });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.post("/nursing/medication-administrations", requireAuth, requireRole(Role.NURSE), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      patientId: z.string().min(1),
      prescriptionItemId: z.string().min(1),
      administeredDose: z.string().trim().min(1).max(120),
      administeredRoute: z.string().trim().min(1).max(120),
      administeredAt: z.coerce.date().optional(),
      notes: z.string().trim().max(1000).optional(),
    }).parse(req.body);
    const access = await patientIsAccessible(req.auth!.userId, req.auth!.role, input.patientId);
    if (access !== "ALLOWED") return clinicalError(res, 404, "PATIENT_NOT_FOUND", "The requested patient was not found or does not have an active admission.");
    const item = await prisma.prescriptionItem.findFirst({
      where: { id: input.prescriptionItemId, prescription: { patientId: input.patientId, status: PrescriptionStatus.SIGNED } },
      select: { id: true },
    });
    if (!item) return clinicalError(res, 400, "SIGNED_PRESCRIPTION_REQUIRED", "Medication administration records must reference a signed prescription for this patient.");
    const administration = await prisma.$transaction(async (tx) => {
      const created = await tx.medicationAdministration.create({
        data: { ...input, administeredById: req.auth!.userId },
        include: { prescriptionItem: { include: { medicine: { select: { id: true, name: true } } } } },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "RECORD_ADMINISTRATION", entity: "MEDICATION_ADMINISTRATION", entityId: created.id, metadata: { prescriptionItemId: input.prescriptionItemId } }) });
      return created;
    });
    res.status(201).json({ data: administration });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.get("/emergency/triage-categories", requireAuth, requireRole(Role.DOCTOR, Role.NURSE, Role.RECEPTIONIST, ...administrators), async (req: AuthenticatedRequest, res, next) => {
  try {
    const includeInactive = req.query.includeInactive === "true" && administrators.includes(req.auth!.role as (typeof administrators)[number]);
    const categories = await prisma.emergencyTriageCategory.findMany({
      where: includeInactive ? undefined : { active: true },
      orderBy: [{ priority: "asc" }, { label: "asc" }],
    });
    res.json({ data: categories });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.post("/emergency/triage-categories", requireAuth, requireRole(...administrators), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      code: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
      label: z.string().trim().min(1).max(120),
      priority: z.number().int().min(1).max(100_000),
    }).parse(req.body);
    const category = await prisma.$transaction(async (tx) => {
      const created = await tx.emergencyTriageCategory.create({ data: { ...input, createdById: req.auth!.userId } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE", entity: "TRIAGE_CATEGORY", entityId: created.id, metadata: { code: created.code } }) });
      return created;
    });
    res.status(201).json({ data: category });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.patch("/emergency/triage-categories/:id", requireAuth, requireRole(...administrators), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      label: z.string().trim().min(1).max(120).optional(),
      priority: z.number().int().min(1).max(100_000).optional(),
      active: z.boolean().optional(),
    }).parse(req.body);
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.emergencyTriageCategory.update({ where: { id: String(req.params.id) }, data: input });
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE", entity: "TRIAGE_CATEGORY", entityId: updated.id, metadata: { active: updated.active } }) });
      return updated;
    });
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.get("/emergency/visits", requireAuth, requireRole(Role.DOCTOR, Role.NURSE, Role.RECEPTIONIST), async (req: AuthenticatedRequest, res, next) => {
  try {
    const query = z.object({
      patientId: z.string().min(1).optional(),
      status: z.nativeEnum(EmergencyVisitStatus).optional(),
    }).parse(req.query);
    const where: Prisma.EmergencyVisitWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.patientId) {
      const access = await patientIsAccessible(req.auth!.userId, req.auth!.role, query.patientId, false);
      if (access === "DOCTOR_PROFILE_REQUIRED") return clinicalError(res, 403, access, "A doctor profile is required for this resource.");
      if (access !== "ALLOWED") return clinicalError(res, 404, "PATIENT_NOT_FOUND", "The requested patient was not found or is outside your clinical scope.");
      where.patientId = query.patientId;
    }
    if (req.auth!.role === Role.DOCTOR) {
      const doctor = await doctorDepartment(req.auth!.userId);
      if (!doctor) return clinicalError(res, 403, "DOCTOR_PROFILE_REQUIRED", "A doctor profile is required for this resource.");
      where.patient = { departmentId: doctor.departmentId };
    }
    const visits = await prisma.emergencyVisit.findMany({
      where,
      include: {
        patient: { select: { id: true, patientNumber: true, firstName: true, lastName: true } },
        triageCategory: true,
        assignedClinician: { select: { id: true, name: true, role: true } },
        triagedBy: { select: { id: true, name: true } },
      },
      orderBy: [{ status: "asc" }, { arrivedAt: "asc" }],
    });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "EMERGENCY_VISIT", metadata: { recordCount: visits.length } }) });
    res.json({ data: visits });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.post("/emergency/visits", requireAuth, requireRole(Role.DOCTOR, Role.NURSE, Role.RECEPTIONIST), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      patientId: z.string().min(1),
      chiefComplaint: z.string().trim().min(1).max(2000),
      triageCategoryId: z.string().min(1).optional(),
      triageNotes: z.string().trim().max(4000).optional(),
    }).parse(req.body);
    if (req.auth!.role === Role.RECEPTIONIST && input.triageCategoryId) {
      return clinicalError(res, 403, "TRIAGE_CLINICIAN_REQUIRED", "Only a clinician may assign an emergency triage category.");
    }
    const access = await patientIsAccessible(req.auth!.userId, req.auth!.role, input.patientId, false);
    if (access === "DOCTOR_PROFILE_REQUIRED") return clinicalError(res, 403, access, "A doctor profile is required for this resource.");
    if (access !== "ALLOWED") return clinicalError(res, 404, "PATIENT_NOT_FOUND", "The requested patient was not found or is outside your clinical scope.");
    if (input.triageCategoryId) {
      const category = await prisma.emergencyTriageCategory.findFirst({ where: { id: input.triageCategoryId, active: true }, select: { id: true } });
      if (!category) return clinicalError(res, 400, "INVALID_TRIAGE_CATEGORY", "Choose an active, configured triage category.");
    }
    const visit = await prisma.$transaction(async (tx) => {
      const created = await tx.emergencyVisit.create({
        data: {
          ...input,
          createdById: req.auth!.userId,
          triagedById: input.triageCategoryId ? req.auth!.userId : undefined,
          triagedAt: input.triageCategoryId ? new Date() : undefined,
        },
        include: { patient: { select: { id: true, patientNumber: true, firstName: true, lastName: true } }, triageCategory: true },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE", entity: "EMERGENCY_VISIT", entityId: created.id, metadata: { triaged: Boolean(input.triageCategoryId) } }) });
      return created;
    });
    res.status(201).json({ data: visit });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.patch("/emergency/visits/:id/triage", requireAuth, requireRole(Role.DOCTOR, Role.NURSE), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      triageCategoryId: z.string().min(1),
      triageNotes: z.string().trim().max(4000).optional(),
    }).parse(req.body);
    const current = await prisma.emergencyVisit.findUnique({ where: { id: String(req.params.id) } });
    const activeStatuses: EmergencyVisitStatus[] = [EmergencyVisitStatus.WAITING, EmergencyVisitStatus.IN_PROGRESS];
    if (!current || !activeStatuses.includes(current.status)) {
      return clinicalError(res, 404, "EMERGENCY_VISIT_NOT_FOUND", "The active emergency visit was not found.");
    }
    const access = await patientIsAccessible(req.auth!.userId, req.auth!.role, current.patientId, false);
    if (access === "DOCTOR_PROFILE_REQUIRED") return clinicalError(res, 403, access, "A doctor profile is required for this resource.");
    if (access !== "ALLOWED") return clinicalError(res, 404, "EMERGENCY_VISIT_NOT_FOUND", "The active emergency visit was not found.");
    const category = await prisma.emergencyTriageCategory.findFirst({ where: { id: input.triageCategoryId, active: true }, select: { id: true } });
    if (!category) return clinicalError(res, 400, "INVALID_TRIAGE_CATEGORY", "Choose an active, configured triage category.");
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.emergencyVisit.updateMany({
        where: { id: current.id, status: current.status },
        data: { ...input, triagedById: req.auth!.userId, triagedAt: new Date() },
      });
      if (updated.count !== 1) return null;
      const visit = await tx.emergencyVisit.findUniqueOrThrow({ where: { id: current.id }, include: { triageCategory: true } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "TRIAGE", entity: "EMERGENCY_VISIT", entityId: visit.id, metadata: { categoryId: input.triageCategoryId } }) });
      return visit;
    });
    if (!result) return clinicalError(res, 409, "EMERGENCY_VISIT_CHANGED", "The visit changed before triage was recorded.");
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

clinicalRouter.patch("/emergency/visits/:id/status", requireAuth, requireRole(Role.DOCTOR, Role.NURSE), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      status: z.nativeEnum(EmergencyVisitStatus),
      admissionId: z.string().min(1).optional(),
    }).parse(req.body);
    const current = await prisma.emergencyVisit.findUnique({ where: { id: String(req.params.id) } });
    if (!current) return clinicalError(res, 404, "EMERGENCY_VISIT_NOT_FOUND", "The emergency visit was not found.");
    const access = await patientIsAccessible(req.auth!.userId, req.auth!.role, current.patientId, false);
    if (access === "DOCTOR_PROFILE_REQUIRED") return clinicalError(res, 403, access, "A doctor profile is required for this resource.");
    if (access !== "ALLOWED") return clinicalError(res, 404, "EMERGENCY_VISIT_NOT_FOUND", "The emergency visit was not found.");
    const allowed: EmergencyVisitStatus[] = current.status === EmergencyVisitStatus.WAITING
      ? [EmergencyVisitStatus.IN_PROGRESS, EmergencyVisitStatus.TRANSFERRED]
      : current.status === EmergencyVisitStatus.IN_PROGRESS
        ? [EmergencyVisitStatus.ADMITTED, EmergencyVisitStatus.DISCHARGED, EmergencyVisitStatus.TRANSFERRED]
        : [];
    if (!allowed.includes(input.status)) return clinicalError(res, 409, "INVALID_EMERGENCY_TRANSITION", "The requested emergency status transition is not allowed.");
    if (input.status === EmergencyVisitStatus.ADMITTED) {
      const admission = input.admissionId
        ? await prisma.admission.findFirst({ where: { id: input.admissionId, patientId: current.patientId, status: "ACTIVE" }, select: { id: true } })
        : null;
      if (!admission) return clinicalError(res, 400, "ACTIVE_ADMISSION_REQUIRED", "An active admission for this patient is required to mark the visit admitted.");
    } else if (input.admissionId) {
      return clinicalError(res, 400, "ADMISSION_NOT_APPLICABLE", "An admission may only be linked when the visit is admitted.");
    }
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.emergencyVisit.updateMany({
        where: { id: current.id, status: current.status },
        data: {
          status: input.status,
          admissionId: input.admissionId,
          closedAt: ([EmergencyVisitStatus.DISCHARGED, EmergencyVisitStatus.TRANSFERRED] as EmergencyVisitStatus[]).includes(input.status) ? new Date() : null,
        },
      });
      if (updated.count !== 1) return null;
      const visit = await tx.emergencyVisit.findUniqueOrThrow({ where: { id: current.id } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE_STATUS", entity: "EMERGENCY_VISIT", entityId: visit.id, metadata: { status: visit.status } }) });
      return visit;
    });
    if (!result) return clinicalError(res, 409, "EMERGENCY_VISIT_CHANGED", "The visit changed before your update was applied.");
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});
