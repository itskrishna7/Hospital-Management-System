import { Prisma, Role } from "@prisma/client";
import { Router, type Response } from "express";
import { z } from "zod";
import { patientIsAccessible } from "./clinical.js";
import { auditLogData, requireAuth, requireRole, type AuthenticatedRequest } from "./auth.js";
import { prisma } from "./db.js";
import {
  ABDM_IG_VERSION,
  FHIR_EXPORT_MAX_RECORDS_PER_TYPE,
  FHIR_VERSION,
  buildFhirExportBundle,
} from "./fhir-mapping.js";

export const interoperabilityRouter = Router();

const patientIdSchema = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/);
const exportPeriodSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
}).refine(({ from, to }) => !from || !to || from <= to, "The export start must be on or before its end.");
const exportRoles = [Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN, Role.DOCTOR, Role.NURSE] as const;

function patientExportSelect(from?: Date, to?: Date) {
  const period = {
    ...(from ? { gte: from } : {}),
    ...(to ? { lte: to } : {}),
  };
  return {
    id: true,
    patientNumber: true,
    firstName: true,
    lastName: true,
    dateOfBirth: true,
    phone: true,
    appointments: {
      ...(Object.keys(period).length ? { where: { startsAt: period } } : {}),
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: FHIR_EXPORT_MAX_RECORDS_PER_TYPE + 1,
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        status: true,
        doctor: { select: { id: true, user: { select: { name: true } } } },
        department: { select: { id: true, name: true } },
      },
    },
    admissions: {
      ...(Object.keys(period).length ? { where: { admittedAt: period } } : {}),
      orderBy: [{ admittedAt: "asc" }, { id: "asc" }],
      take: FHIR_EXPORT_MAX_RECORDS_PER_TYPE + 1,
      select: {
        id: true,
        admittedAt: true,
        dischargedAt: true,
        status: true,
        bed: { select: { ward: { select: { department: { select: { id: true, name: true } } } } } },
      },
    },
  } satisfies Prisma.PatientSelect;
}

function operationOutcome(res: Response, status: number, severity: "error" | "warning", code: string, diagnostics: string) {
  return res.status(status).setHeader("Cache-Control", "no-store").type("application/fhir+json").send(JSON.stringify({
    resourceType: "OperationOutcome",
    issue: [{ severity, code, diagnostics }],
  }));
}

interoperabilityRouter.get(
  "/interop/fhir/r4/patients/:patientId/$export",
  requireAuth,
  requireRole(...exportRoles),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const parsedId = patientIdSchema.safeParse(req.params.patientId);
      if (!parsedId.success) return operationOutcome(res, 400, "error", "invalid", "The patient identifier is invalid.");
      const parsedPeriod = exportPeriodSchema.safeParse(req.query);
      if (!parsedPeriod.success) return operationOutcome(res, 400, "error", "invalid", parsedPeriod.error.issues[0]?.message ?? "The export period is invalid.");

      const access = await patientIsAccessible(req.auth!.userId, req.auth!.role, parsedId.data);
      if (access === "DOCTOR_PROFILE_REQUIRED") {
        return operationOutcome(res, 403, "error", "forbidden", "A doctor profile is required for this export.");
      }
      if (access !== "ALLOWED") {
        return operationOutcome(res, 404, "error", "not-found", "The patient is unavailable.");
      }

      const patient = await prisma.patient.findUnique({
        where: { id: parsedId.data },
        select: patientExportSelect(parsedPeriod.data.from, parsedPeriod.data.to),
      });
      if (!patient) return operationOutcome(res, 404, "error", "not-found", "The patient is unavailable.");
      if (patient.appointments.length > FHIR_EXPORT_MAX_RECORDS_PER_TYPE || patient.admissions.length > FHIR_EXPORT_MAX_RECORDS_PER_TYPE) {
        return operationOutcome(res, 413, "error", "too-costly", "The export exceeds the per-resource record limit; include a narrower from/to date range.");
      }

      const bundle = buildFhirExportBundle(patient);
      await prisma.auditLog.create({
        data: auditLogData(req, {
          action: "EXPORT",
          entity: "FHIR_BUNDLE",
          entityId: patient.id,
          metadata: {
            fhirVersion: FHIR_VERSION,
            abdmImplementationGuideVersion: ABDM_IG_VERSION,
            resourceCount: bundle.entry.length,
          },
        }),
      });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/fhir+json; charset=utf-8");
      return res.status(200).send(JSON.stringify(bundle));
    } catch (error) {
      next(error);
    }
  },
);
