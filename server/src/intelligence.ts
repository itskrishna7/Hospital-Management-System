import { Router, type Response } from "express";
import {
  AdmissionStatus,
  AppointmentStatus,
  BedStatus,
  HousekeepingTaskStatus,
  HousekeepingTaskType,
  IntelligenceAlertCategory,
  IntelligenceAlertSeverity,
  IntelligenceAlertStatus,
  LabStatus,
  Prisma,
  QueueEntryStatus,
  Role,
} from "@prisma/client";
import { z } from "zod";
import { auditLogData, requireAuth, requireRole, type AuthenticatedRequest } from "./auth.js";
import { prisma } from "./db.js";
import {
  calculateBedForecast,
  calculatePatientFlowForecast,
  simulateBedCapacity,
  simulatePatientFlow,
  simulateStaffing,
  type DailyOperations,
} from "./intelligence-calculations.js";

export const intelligenceRouter = Router();

const administrators = [Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN] as const;
const financeRoles = [...administrators, Role.BILLING_STAFF, Role.ACCOUNTANT] as const;
const pharmacyRoles = [...administrators, Role.PHARMACIST] as const;
const analyticsRoles = [
  ...administrators,
  Role.DOCTOR,
  Role.NURSE,
  Role.RECEPTIONIST,
  Role.PHARMACIST,
  Role.LAB_TECHNICIAN,
  Role.RADIOLOGIST,
  Role.BILLING_STAFF,
  Role.ACCOUNTANT,
  Role.HOUSEKEEPING,
] as const;
const oneDayMs = 24 * 60 * 60 * 1000;
const csvFormulaPrefix = /^[=+\-@]/;

function fail(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message } });
}

function utcDayStart(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number) {
  return new Date(date.getTime() + days * oneDayMs);
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Use a valid YYYY-MM-DD date.");

type DateRange = { start: Date; endExclusive: Date; startDate: string; endDate: string };
type DateRangeResult = { range: DateRange } | { error: { status: number; code: string; message: string } };

function readDateRange(input: { startDate?: string; endDate?: string }, defaultDays = 30): DateRangeResult {
  const today = utcDayStart(new Date());
  const endDate = input.endDate ? new Date(`${input.endDate}T00:00:00.000Z`) : today;
  const start = input.startDate
    ? new Date(`${input.startDate}T00:00:00.000Z`)
    : addUtcDays(endDate, -(defaultDays - 1));
  const endExclusive = addUtcDays(endDate, 1);
  if (start.getTime() > endDate.getTime()) {
    return { error: { status: 400, code: "INVALID_DATE_RANGE", message: "startDate must be on or before endDate." } };
  }
  if (endExclusive.getTime() - start.getTime() > 366 * oneDayMs) {
    return { error: { status: 400, code: "DATE_RANGE_TOO_LARGE", message: "Date ranges are limited to 366 days." } };
  }
  return { range: { start, endExclusive, startDate: dateKey(start), endDate: dateKey(endDate) } };
}

async function getDepartmentScope(req: AuthenticatedRequest, requestedId?: string) {
  if (req.auth!.role === Role.DOCTOR) {
    const doctor = await prisma.doctor.findUnique({
      where: { userId: req.auth!.userId },
      select: { departmentId: true },
    });
    if (!doctor) return { error: { status: 403, code: "DOCTOR_PROFILE_REQUIRED", message: "A doctor profile is required for this resource." } } as const;
    if (requestedId && requestedId !== doctor.departmentId) {
      return { error: { status: 403, code: "DEPARTMENT_SCOPE_FORBIDDEN", message: "Doctors can only view analytics for their own department." } } as const;
    }
    return { departmentId: doctor.departmentId } as const;
  }
  if (requestedId) {
    const department = await prisma.department.findUnique({ where: { id: requestedId }, select: { id: true } });
    if (!department) return { error: { status: 404, code: "DEPARTMENT_NOT_FOUND", message: "The department was not found." } } as const;
  }
  return { departmentId: requestedId } as const;
}

type DepartmentBedCounts = { departmentId: string; total: number; occupied: number; available: number };

async function getBedCountsByDepartment(): Promise<DepartmentBedCounts[]> {
  const [wards, groupedBeds] = await Promise.all([
    prisma.ward.findMany({ select: { id: true, departmentId: true } }),
    prisma.bed.groupBy({ by: ["wardId", "status"], _count: { _all: true } }),
  ]);
  const departmentByWard = new Map(wards.map((ward) => [ward.id, ward.departmentId]));
  const counts = new Map<string, DepartmentBedCounts>();
  for (const group of groupedBeds) {
    const departmentId = departmentByWard.get(group.wardId);
    if (!departmentId) continue;
    const current = counts.get(departmentId) ?? { departmentId, total: 0, occupied: 0, available: 0 };
    current.total += group._count._all;
    if (group.status === BedStatus.OCCUPIED) current.occupied += group._count._all;
    if (group.status === BedStatus.AVAILABLE) current.available += group._count._all;
    counts.set(departmentId, current);
  }
  return [...counts.values()];
}

async function getBedCounts(departmentId?: string) {
  const departments = await getBedCountsByDepartment();
  const selected = departmentId ? departments.filter((item) => item.departmentId === departmentId) : departments;
  return selected.reduce(
    (total, current) => ({
      total: total.total + current.total,
      occupied: total.occupied + current.occupied,
      available: total.available + current.available,
    }),
    { total: 0, occupied: 0, available: 0 },
  );
}

type DepartmentWorkload = {
  departmentId: string;
  departmentName: string;
  appointments: number;
  activeAdmissions: number;
  pendingLabs: number;
  activeQueue: number;
  onDutyDoctors: number;
  workload: number;
};

async function getDepartmentWorkload(input: { start: Date; endExclusive: Date; departmentId?: string }): Promise<DepartmentWorkload[]> {
  const departmentWhere = input.departmentId ? { id: input.departmentId } : {};
  const appointmentWhere = {
    startsAt: { gte: input.start, lt: input.endExclusive },
    status: { not: AppointmentStatus.CANCELLED },
    ...(input.departmentId ? { departmentId: input.departmentId } : {}),
  };
  const admissionWhere = {
    status: AdmissionStatus.ACTIVE,
    ...(input.departmentId ? { patient: { departmentId: input.departmentId } } : {}),
  };
  const labWhere = {
    status: { not: LabStatus.COMPLETED },
    ...(input.departmentId ? { patient: { departmentId: input.departmentId } } : {}),
  };
  const queueWhere = {
    serviceDate: { gte: input.start, lt: input.endExclusive },
    status: { in: [QueueEntryStatus.WAITING, QueueEntryStatus.CALLED, QueueEntryStatus.IN_PROGRESS] },
    ...(input.departmentId ? { departmentId: input.departmentId } : {}),
  };
  const [
    departments,
    appointments,
    doctors,
    admissions,
    labs,
    queues,
  ] = await Promise.all([
    prisma.department.findMany({ where: departmentWhere, select: { id: true, name: true } }),
    prisma.appointment.groupBy({ by: ["departmentId"], where: appointmentWhere, _count: { _all: true } }),
    prisma.doctor.groupBy({ by: ["departmentId"], where: { onDuty: true, ...(input.departmentId ? { departmentId: input.departmentId } : {}) }, _count: { _all: true } }),
    prisma.admission.findMany({ where: admissionWhere, select: { patient: { select: { departmentId: true } } } }),
    prisma.labOrder.findMany({ where: labWhere, select: { patient: { select: { departmentId: true } } } }),
    prisma.queueEntry.groupBy({ by: ["departmentId"], where: queueWhere, _count: { _all: true } }),
  ]);
  const appointmentCounts = new Map(appointments.map((item) => [item.departmentId, item._count._all]));
  const doctorCounts = new Map(doctors.map((item) => [item.departmentId, item._count._all]));
  const queueCounts = new Map(queues.map((item) => [item.departmentId, item._count._all]));
  const admissionCounts = new Map<string, number>();
  const labCounts = new Map<string, number>();
  for (const item of admissions) {
    const departmentId = item.patient.departmentId;
    if (departmentId) admissionCounts.set(departmentId, (admissionCounts.get(departmentId) ?? 0) + 1);
  }
  for (const item of labs) {
    const departmentId = item.patient.departmentId;
    if (departmentId) labCounts.set(departmentId, (labCounts.get(departmentId) ?? 0) + 1);
  }
  return departments.map((department) => {
    const appointmentCount = appointmentCounts.get(department.id) ?? 0;
    const admissionCount = admissionCounts.get(department.id) ?? 0;
    return {
      departmentId: department.id,
      departmentName: department.name,
      appointments: appointmentCount,
      activeAdmissions: admissionCount,
      pendingLabs: labCounts.get(department.id) ?? 0,
      activeQueue: queueCounts.get(department.id) ?? 0,
      onDutyDoctors: doctorCounts.get(department.id) ?? 0,
      workload: appointmentCount + admissionCount,
    };
  });
}

function metric(value: number | null, unit: string, sampleCount: number, formula: string, reason?: string) {
  return {
    status: value === null || !Number.isFinite(value) ? "unavailable" as const : "available" as const,
    value: value === null || !Number.isFinite(value) ? null : Number(value.toFixed(2)),
    unit,
    sampleCount,
    formula,
    ...(reason ? { reason } : {}),
  };
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function inScopeCategory(role: Role, category: IntelligenceAlertCategory) {
  const categoryRoles: Record<IntelligenceAlertCategory, Role[]> = {
    [IntelligenceAlertCategory.BED]: [...administrators, Role.DOCTOR, Role.NURSE, Role.RECEPTIONIST, Role.HOUSEKEEPING],
    [IntelligenceAlertCategory.INVENTORY]: [...pharmacyRoles],
    [IntelligenceAlertCategory.LABORATORY]: [...administrators, Role.DOCTOR, Role.NURSE, Role.LAB_TECHNICIAN, Role.RADIOLOGIST],
    [IntelligenceAlertCategory.DISCHARGE]: [...administrators, Role.DOCTOR, Role.NURSE, Role.RECEPTIONIST],
    [IntelligenceAlertCategory.DEPARTMENT]: [...administrators, Role.DOCTOR, Role.NURSE, Role.RECEPTIONIST],
    [IntelligenceAlertCategory.BILLING]: [...financeRoles],
  };
  return categoryRoles[category].includes(role);
}

const alertRuleDefinitions = [
  { key: "BED_OCCUPANCY_WARNING", category: IntelligenceAlertCategory.BED, severity: IntelligenceAlertSeverity.WARNING, threshold: 85, unit: "percent", label: "High bed occupancy", description: "Hospital/department occupancy percentage at or above this threshold." },
  { key: "BED_OCCUPANCY_CRITICAL", category: IntelligenceAlertCategory.BED, severity: IntelligenceAlertSeverity.CRITICAL, threshold: 95, unit: "percent", label: "Critical bed occupancy", description: "Hospital/department occupancy percentage at or above this threshold." },
  { key: "BED_SHORTAGE", category: IntelligenceAlertCategory.BED, severity: IntelligenceAlertSeverity.CRITICAL, threshold: 2, unit: "beds", label: "Critical bed shortage", description: "Alert when available beds are at or below this count." },
  { key: "BED_TURNOVER_DELAY_HOURS", category: IntelligenceAlertCategory.BED, severity: IntelligenceAlertSeverity.WARNING, threshold: 4, unit: "hours", label: "Delayed bed turnover cleaning", description: "Open terminal-cleaning tasks older than this duration." },
  { key: "INVENTORY_LOW_UNITS", category: IntelligenceAlertCategory.INVENTORY, severity: IntelligenceAlertSeverity.WARNING, threshold: 10, unit: "units", label: "Low medicine stock", description: "Global minimum stock units; an existing medicine reorder level can be higher." },
  { key: "INVENTORY_LOW_DAYS", category: IntelligenceAlertCategory.INVENTORY, severity: IntelligenceAlertSeverity.WARNING, threshold: 7, unit: "days", label: "Low estimated stock duration", description: "Alert when reliable recorded consumption estimates fewer remaining stock days." },
  { key: "MEDICINE_EXPIRY_DAYS", category: IntelligenceAlertCategory.INVENTORY, severity: IntelligenceAlertSeverity.WARNING, threshold: 30, unit: "days", label: "Medicine expiring soon", description: "Alert for stocked medicines expiring within this many days." },
  { key: "LAB_PENDING_WARNING_HOURS", category: IntelligenceAlertCategory.LABORATORY, severity: IntelligenceAlertSeverity.WARNING, threshold: 24, unit: "hours", label: "Delayed laboratory order", description: "Pending lab orders older than this duration." },
  { key: "LAB_PENDING_CRITICAL_HOURS", category: IntelligenceAlertCategory.LABORATORY, severity: IntelligenceAlertSeverity.CRITICAL, threshold: 72, unit: "hours", label: "Critically delayed laboratory order", description: "Pending lab orders older than this duration." },
  { key: "DISCHARGE_PENDING_HOURS", category: IntelligenceAlertCategory.DISCHARGE, severity: IntelligenceAlertSeverity.WARNING, threshold: 8, unit: "hours", label: "Delayed discharge processing", description: "Doctor-approved checklists not finalized within this duration." },
  { key: "DEPARTMENT_LOAD_PER_DOCTOR", category: IntelligenceAlertCategory.DEPARTMENT, severity: IntelligenceAlertSeverity.WARNING, threshold: 8, unit: "work items per on-duty doctor", label: "High department workload", description: "Today's appointments plus active admissions per on-duty doctor." },
  { key: "PENDING_BILLING_DAYS", category: IntelligenceAlertCategory.BILLING, severity: IntelligenceAlertSeverity.WARNING, threshold: 30, unit: "days", label: "Aged outstanding invoices", description: "Outstanding invoices at least this many days old." },
] as const;

type AlertDraft = {
  ruleKey: string;
  category: IntelligenceAlertCategory;
  severity: IntelligenceAlertSeverity;
  title: string;
  description: string;
  dedupeKey: string;
  departmentId?: string;
  metricValue?: number;
  threshold?: number;
};

function csvCell(value: string | number) {
  let text = String(value);
  if (csvFormulaPrefix.test(text)) text = `'${text}`;
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function csvReport(rows: Array<Array<string | number>>) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

const briefingQuerySchema = z.object({
  date: dateOnly.optional(),
  departmentId: z.string().min(1).max(64).optional(),
  format: z.enum(["json", "csv"]).default("json"),
});
const rangeQuerySchema = z.object({
  startDate: dateOnly.optional(),
  endDate: dateOnly.optional(),
  departmentId: z.string().min(1).max(64).optional(),
});
const forecastQuerySchema = z.object({
  departmentId: z.string().min(1).max(64).optional(),
  lookbackDays: z.coerce.number().int().min(7).max(90).default(28),
  horizonDays: z.coerce.number().int().min(1).max(14).default(7),
});

intelligenceRouter.get("/intelligence/departments", requireAuth, requireRole(...analyticsRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const scope = await getDepartmentScope(req);
    if (scope.error) return fail(res, scope.error.status, scope.error.code, scope.error.message);
    const departments = await prisma.department.findMany({
      where: scope.departmentId ? { id: scope.departmentId } : {},
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    res.json({ data: departments });
  } catch (error) {
    next(error);
  }
});

intelligenceRouter.get("/intelligence/briefing", requireAuth, requireRole(...analyticsRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const parsed = briefingQuerySchema.safeParse(req.query);
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid briefing filters.");
    const date = parsed.data.date ? new Date(`${parsed.data.date}T00:00:00.000Z`) : utcDayStart(new Date());
    const endExclusive = addUtcDays(date, 1);
    const scope = await getDepartmentScope(req, parsed.data.departmentId);
    if (scope.error) return fail(res, scope.error.status, scope.error.code, scope.error.message);
    const departmentWhere = scope.departmentId ? { departmentId: scope.departmentId } : {};
    const patientDepartmentWhere = scope.departmentId ? { patient: { departmentId: scope.departmentId } } : {};
    const [appointmentPatients, queuePatients, newAdmissionPatients, activeAdmissions, beds, pendingLabs, pendingDischarges, lowStock, expiring, workloads] = await Promise.all([
      prisma.appointment.findMany({
        where: { startsAt: { gte: date, lt: endExclusive }, status: { not: AppointmentStatus.CANCELLED }, ...departmentWhere },
        select: { patientId: true },
      }),
      prisma.queueEntry.findMany({
        where: { checkedInAt: { gte: date, lt: endExclusive }, ...departmentWhere },
        select: { patientId: true },
      }),
      prisma.admission.findMany({
        where: { admittedAt: { gte: date, lt: endExclusive }, ...patientDepartmentWhere },
        select: { patientId: true },
      }),
      prisma.admission.count({ where: { status: AdmissionStatus.ACTIVE, ...patientDepartmentWhere } }),
      getBedCounts(scope.departmentId),
      prisma.labOrder.count({ where: { status: { not: LabStatus.COMPLETED }, ...patientDepartmentWhere } }),
      prisma.dischargeChecklist.count({
        where: { approvedAt: { not: null }, finalizedAt: null, admission: { status: AdmissionStatus.ACTIVE, ...patientDepartmentWhere } },
      }),
      pharmacyRoles.includes(req.auth!.role as (typeof pharmacyRoles)[number])
        ? prisma.medicine.findMany({ select: { quantity: true, reorderLevel: true } }).then((medicines) => ({
          outOfStock: medicines.filter((medicine) => medicine.quantity <= 0).length,
          lowStock: medicines.filter((medicine) => medicine.quantity > 0 && medicine.reorderLevel > 0 && medicine.quantity <= medicine.reorderLevel).length,
        }))
        : Promise.resolve(null),
      pharmacyRoles.includes(req.auth!.role as (typeof pharmacyRoles)[number])
        ? prisma.medicine.count({ where: { quantity: { gt: 0 }, expiresAt: { gte: date, lt: addUtcDays(date, 31) } } })
        : Promise.resolve(null),
      getDepartmentWorkload({ start: date, endExclusive, departmentId: scope.departmentId }),
    ]);
    const patientCount = new Set([
      ...appointmentPatients.map((item) => item.patientId),
      ...queuePatients.map((item) => item.patientId),
      ...newAdmissionPatients.map((item) => item.patientId),
    ]).size;
    const data: Record<string, unknown> = {
      date: dateKey(date),
      departmentId: scope.departmentId ?? null,
      patientsToday: patientCount,
      appointmentsToday: appointmentPatients.length,
      currentAdmissions: activeAdmissions,
      beds: { total: beds.total, available: beds.available, occupied: beds.occupied },
      pendingLaboratoryOrders: pendingLabs,
      pendingDischarges,
      departmentWorkload: workloads,
    };
    if (lowStock) data.inventory = { lowStockMedicines: lowStock.lowStock, outOfStockMedicines: lowStock.outOfStock, expiringMedicines: expiring };
    if (financeRoles.includes(req.auth!.role as (typeof financeRoles)[number])) {
      const invoices = await prisma.invoice.aggregate({
        where: { balance: { gt: 0 }, ...patientDepartmentWhere },
        _count: { _all: true },
        _sum: { balance: true },
      });
      data.outstandingInvoices = {
        count: invoices._count._all,
        balance: invoices._sum.balance ? Number(invoices._sum.balance) : 0,
      };
    }
    await prisma.auditLog.create({
      data: auditLogData(req, { action: parsed.data.format === "csv" ? "EXPORT" : "READ", entity: "OPERATIONS_BRIEFING", metadata: { date: dateKey(date), departmentId: scope.departmentId } }),
    });
    if (parsed.data.format === "csv") {
      const rows: Array<Array<string | number>> = [
        ["Metric", "Value", "Date", "Department"],
        ["Patients today (unique appointments, check-ins, and new admissions)", patientCount, dateKey(date), scope.departmentId ?? "All departments"],
        ["Appointments today", appointmentPatients.length, dateKey(date), scope.departmentId ?? "All departments"],
        ["Current admissions", activeAdmissions, dateKey(date), scope.departmentId ?? "All departments"],
        ["Total beds", beds.total, dateKey(date), scope.departmentId ?? "All departments"],
        ["Occupied beds", beds.occupied, dateKey(date), scope.departmentId ?? "All departments"],
        ["Available beds", beds.available, dateKey(date), scope.departmentId ?? "All departments"],
        ["Pending laboratory orders", pendingLabs, dateKey(date), scope.departmentId ?? "All departments"],
        ["Pending approved discharges", pendingDischarges, dateKey(date), scope.departmentId ?? "All departments"],
      ];
      if (lowStock) {
        rows.push(["Low-stock medicines", lowStock.lowStock, dateKey(date), "Hospital-wide"]);
        rows.push(["Out-of-stock medicines", lowStock.outOfStock, dateKey(date), "Hospital-wide"]);
        rows.push(["Expiring medicines (30 days)", expiring ?? 0, dateKey(date), "Hospital-wide"]);
      }
      if (data.outstandingInvoices && typeof data.outstandingInvoices === "object") {
        const invoices = data.outstandingInvoices as { count: number; balance: number };
        rows.push(["Outstanding invoices", invoices.count, dateKey(date), scope.departmentId ?? "All departments"]);
        rows.push(["Outstanding invoice balance", invoices.balance, dateKey(date), scope.departmentId ?? "All departments"]);
      }
      for (const workload of workloads) rows.push([`Workload · ${workload.departmentName}`, workload.workload, dateKey(date), workload.departmentName]);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).type("text/csv").attachment(`mediverse-briefing-${dateKey(date)}.csv`).send(csvReport(rows));
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

intelligenceRouter.get("/intelligence/forecasts", requireAuth, requireRole(...analyticsRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const parsed = forecastQuerySchema.safeParse(req.query);
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid forecast filters.");
    const scope = await getDepartmentScope(req, parsed.data.departmentId);
    if (scope.error) return fail(res, scope.error.status, scope.error.code, scope.error.message);
    const now = new Date();
    const today = utcDayStart(now);
    const start = addUtcDays(today, -parsed.data.lookbackDays);
    const endExclusive = today;
    const patientDepartmentWhere = scope.departmentId ? { patient: { departmentId: scope.departmentId } } : {};
    const [
      appointments,
      admissions,
      currentBeds,
      workload,
      medicines,
      consumption,
    ] = await Promise.all([
      prisma.appointment.findMany({
        where: { startsAt: { gte: start, lt: endExclusive }, status: { not: AppointmentStatus.CANCELLED }, ...(scope.departmentId ? { departmentId: scope.departmentId } : {}) },
        select: { startsAt: true },
      }),
      prisma.admission.findMany({
        where: {
          admittedAt: { lt: endExclusive },
          OR: [{ dischargedAt: null }, { dischargedAt: { gt: start } }],
          ...patientDepartmentWhere,
        },
        select: { bedId: true, admittedAt: true, dischargedAt: true, status: true },
      }),
      getBedCounts(scope.departmentId),
      getDepartmentWorkload({ start: today, endExclusive: addUtcDays(today, 1), departmentId: scope.departmentId }),
      pharmacyRoles.includes(req.auth!.role as (typeof pharmacyRoles)[number])
        ? prisma.medicine.findMany({ select: { id: true, name: true, sku: true, quantity: true, reorderLevel: true } })
        : Promise.resolve([]),
      pharmacyRoles.includes(req.auth!.role as (typeof pharmacyRoles)[number])
        ? prisma.$queryRaw<Array<{
          medicineId: string;
          consumedUnits: number;
          transactionCount: number;
          consumptionDays: number;
          firstConsumedAt: Date;
        }>>`
          SELECT "medicineId",
                 SUM(ABS("quantity"))::double precision AS "consumedUnits",
                 COUNT(*)::int AS "transactionCount",
                 COUNT(DISTINCT "createdAt"::date)::int AS "consumptionDays",
                 MIN("createdAt") AS "firstConsumedAt"
          FROM "InventoryTransaction"
          WHERE "quantity" < 0 AND "createdAt" >= ${start} AND "createdAt" < ${endExclusive}
          GROUP BY "medicineId"
        `
        : Promise.resolve([]),
    ]);
    const daily = new Map<string, DailyOperations>();
    for (let offset = 0; offset < parsed.data.lookbackDays; offset++) {
      const date = dateKey(addUtcDays(start, offset));
      daily.set(date, { date, admissions: 0, discharges: 0, appointments: 0 });
    }
    for (const appointment of appointments) {
      const day = daily.get(dateKey(appointment.startsAt));
      if (day) day.appointments++;
    }
    for (const admission of admissions) {
      const admittedDay = daily.get(dateKey(admission.admittedAt));
      if (admittedDay) admittedDay.admissions++;
      if (admission.dischargedAt) {
        const dischargedDay = daily.get(dateKey(admission.dischargedAt));
        if (dischargedDay) dischargedDay.discharges++;
      }
    }
    const history = [...daily.values()];
    const observedActivityDays = history.filter((day) => day.admissions + day.discharges + day.appointments > 0).length;
    const coverageDays = Math.min(parsed.data.lookbackDays, observedActivityDays);
    const historicalOccupancy = history.map((day) => {
      const dayEnd = addUtcDays(new Date(`${day.date}T00:00:00.000Z`), 1);
      const occupied = new Set(admissions
        .filter((admission) => admission.admittedAt < dayEnd && (!admission.dischargedAt || admission.dischargedAt >= dayEnd))
        .map((admission) => admission.bedId)).size;
      return { date: day.date, occupiedBeds: occupied, availableBeds: Math.max(0, currentBeds.total - occupied) };
    });
    const bedForecast = calculateBedForecast({
      history,
      currentOccupancy: currentBeds.occupied,
      totalBeds: currentBeds.total,
      asOf: today,
      horizonDays: parsed.data.horizonDays,
      coverageDays,
    });
    const patientFlow = calculatePatientFlowForecast({
      history,
      asOf: today,
      horizonDays: parsed.data.horizonDays,
      coverageDays,
    });
    const consumptionByMedicine = new Map(consumption.map((item) => [item.medicineId, item]));
    const inventoryForecast = medicines.map((medicine) => {
      const observed = consumptionByMedicine.get(medicine.id);
      const observedDays = observed ? Math.max(1, Math.floor((now.getTime() - observed.firstConsumedAt.getTime()) / oneDayMs)) : 0;
      const sufficient = Boolean(observed && observed.transactionCount >= 3 && observed.consumptionDays >= 3 && observedDays >= 14);
      const dailyConsumption = sufficient && observed ? observed.consumedUnits / observedDays : null;
      return {
        name: medicine.name,
        sku: medicine.sku,
        currentStock: medicine.quantity,
        reorderLevel: medicine.reorderLevel,
        status: sufficient ? "available" as const : "insufficient_history" as const,
        estimatedDailyConsumption: dailyConsumption === null ? null : Number(dailyConsumption.toFixed(2)),
        estimatedDaysRemaining: dailyConsumption && dailyConsumption > 0 ? Number((medicine.quantity / dailyConsumption).toFixed(1)) : null,
        sampleTransactions: observed?.transactionCount ?? 0,
        sampleDays: observed?.consumptionDays ?? 0,
        formula: "Current stock / (recorded negative inventory transaction units / days since first recorded consumption).",
        reason: sufficient ? undefined : "Insufficient dated outbound inventory transactions; prescriptions are not treated as dispensing.",
      };
    });
    await prisma.auditLog.create({
      data: auditLogData(req, { action: "READ", entity: "OPERATIONAL_FORECAST", metadata: { lookbackDays: parsed.data.lookbackDays, horizonDays: parsed.data.horizonDays, departmentId: scope.departmentId } }),
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      data: {
        generatedAt: now.toISOString(),
        historicalPeriod: {
          startDate: dateKey(start),
          endDate: dateKey(addUtcDays(today, -1)),
          days: parsed.data.lookbackDays,
          observedActivityDays,
        },
        horizonDays: parsed.data.horizonDays,
        departmentId: scope.departmentId ?? null,
        estimatesOnly: true,
        bedOccupancy: { ...bedForecast, historicalTrend: historicalOccupancy },
        patientFlow: patientFlow,
        departmentWorkload: workload.map((department) => ({
          ...department,
          workloadPerOnDutyDoctor: department.onDutyDoctors > 0 ? Number((department.workload / department.onDutyDoctors).toFixed(2)) : null,
          pressure: department.onDutyDoctors === 0 && department.workload > 0
            ? "no_on_duty_doctors"
            : department.onDutyDoctors > 0 && department.workload / department.onDutyDoctors >= 8 ? "high" : "within_default_threshold",
          thresholdWorkItemsPerDoctor: 8,
          formula: "Today's non-cancelled appointments plus active admissions, divided by on-duty doctors.",
        })),
        inventory: pharmacyRoles.includes(req.auth!.role as (typeof pharmacyRoles)[number])
          ? {
            status: inventoryForecast.some((item) => item.status === "available") ? "partial" : "insufficient_history",
            historicalPeriodDays: parsed.data.lookbackDays,
            forecasts: inventoryForecast,
          }
          : { status: "unavailable", reason: "Inventory analytics require a pharmacy or administrator role." },
      },
    });
  } catch (error) {
    next(error);
  }
});

intelligenceRouter.get("/intelligence/analytics", requireAuth, requireRole(...analyticsRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const parsed = rangeQuerySchema.safeParse(req.query);
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid analytics filters.");
    const dateResult = readDateRange(parsed.data);
    if ("error" in dateResult) return fail(res, dateResult.error.status, dateResult.error.code, dateResult.error.message);
    const scope = await getDepartmentScope(req, parsed.data.departmentId);
    if (scope.error) return fail(res, scope.error.status, scope.error.code, scope.error.message);
    const { start, endExclusive, startDate, endDate } = dateResult.range;
    const today = new Date();
    const patientDepartmentWhere = scope.departmentId ? { patient: { departmentId: scope.departmentId } } : {};
    const [
      appointments,
      queues,
      admissions,
      finalizedChecklists,
      completedLabs,
      beds,
      departments,
      inventory,
      invoices,
    ] = await Promise.all([
      prisma.appointment.findMany({
        where: { startsAt: { gte: start, lt: endExclusive }, endsAt: { lte: today }, status: { in: [AppointmentStatus.COMPLETED, AppointmentStatus.CANCELLED] }, ...(scope.departmentId ? { departmentId: scope.departmentId } : {}) },
        select: { status: true },
      }),
      prisma.queueEntry.findMany({
        where: { serviceDate: { gte: start, lt: endExclusive }, calledAt: { not: null }, ...(scope.departmentId ? { departmentId: scope.departmentId } : {}) },
        select: { checkedInAt: true, calledAt: true },
      }),
      prisma.admission.findMany({
        where: {
          admittedAt: { lt: endExclusive },
          OR: [{ dischargedAt: null }, { dischargedAt: { gte: start } }],
          ...patientDepartmentWhere,
        },
        select: { bedId: true, admittedAt: true, dischargedAt: true, status: true },
      }),
      prisma.dischargeChecklist.findMany({
        where: { finalizedAt: { gte: start, lt: endExclusive }, approvedAt: { not: null }, admission: patientDepartmentWhere },
        select: { createdAt: true, finalizedAt: true },
      }),
      prisma.labOrder.findMany({
        where: { status: LabStatus.COMPLETED, result: { is: { createdAt: { gte: start, lt: endExclusive } } }, ...patientDepartmentWhere },
        select: { createdAt: true, result: { select: { createdAt: true } } },
      }),
      getBedCounts(scope.departmentId),
      getDepartmentWorkload({ start, endExclusive, departmentId: scope.departmentId }),
      pharmacyRoles.includes(req.auth!.role as (typeof pharmacyRoles)[number])
        ? prisma.$queryRaw<Array<{ date: Date; units: number; transactionCount: number }>>`
          SELECT DATE("createdAt") AS date,
                 SUM(ABS("quantity"))::double precision AS units,
                 COUNT(*)::int AS "transactionCount"
          FROM "InventoryTransaction"
          WHERE "quantity" < 0 AND "createdAt" >= ${start} AND "createdAt" < ${endExclusive}
          GROUP BY DATE("createdAt")
          ORDER BY DATE("createdAt")
        `
        : Promise.resolve(null),
      financeRoles.includes(req.auth!.role as (typeof financeRoles)[number])
        ? prisma.invoice.aggregate({
          where: { createdAt: { gte: start, lt: endExclusive }, ...patientDepartmentWhere },
          _count: { _all: true },
          _sum: { total: true, balance: true },
        })
        : Promise.resolve(null),
    ]);
    const completionCount = appointments.filter((item) => item.status === AppointmentStatus.COMPLETED).length;
    const terminalAppointments = appointments.length;
    const waitingMinutes = queues.flatMap((item) => {
      if (!item.calledAt || item.calledAt < item.checkedInAt) return [];
      return [(item.calledAt.getTime() - item.checkedInAt.getTime()) / 60_000];
    });
    const dischargeHours = finalizedChecklists.flatMap((item) => item.finalizedAt ? [(item.finalizedAt.getTime() - item.createdAt.getTime()) / 3_600_000] : []);
    const labHours = completedLabs.flatMap((item) => item.result ? [(item.result.createdAt.getTime() - item.createdAt.getTime()) / 3_600_000] : []);
    const closedAdmissions = admissions.filter((item) => item.dischargedAt && item.dischargedAt >= start && item.dischargedAt < endExclusive);
    const stayHours = closedAdmissions.flatMap((item) => item.dischargedAt ? [(item.dischargedAt.getTime() - item.admittedAt.getTime()) / 3_600_000] : []);
    const occupancySamples = Array.from({ length: Math.ceil((endExclusive.getTime() - start.getTime()) / oneDayMs) }, (_, index) => {
      const sampleEnd = addUtcDays(start, index + 1);
      const occupied = new Set(admissions
        .filter((item) => item.admittedAt < sampleEnd && (!item.dischargedAt || item.dischargedAt >= sampleEnd))
        .map((item) => item.bedId)).size;
      return beds.total > 0 ? (occupied / beds.total) * 100 : null;
    }).filter((value): value is number => value !== null);
    const billed = invoices?._sum.total ? Number(invoices._sum.total) : 0;
    const outstanding = invoices?._sum.balance ? Number(invoices._sum.balance) : 0;
    const collected = invoices ? billed - outstanding : undefined;
    const data = {
      dateRange: { startDate, endDate },
      departmentId: scope.departmentId ?? null,
      metrics: {
        averageWaitingTime: metric(average(waitingMinutes), "minutes", waitingMinutes.length, "Mean of calledAt - checkedInAt for queue entries called within the selected service dates.", waitingMinutes.length ? undefined : "Queue service timestamps are being collected from the Phase 6 release onward."),
        appointmentCompletionRate: metric(terminalAppointments ? (completionCount / terminalAppointments) * 100 : null, "percent", terminalAppointments, "Completed appointments / (completed + cancelled) appointments with end time in the past."),
        bedOccupancyRate: metric(occupancySamples.length && admissions.length ? average(occupancySamples) : null, "percent", occupancySamples.length && admissions.length ? occupancySamples.length : 0, "Mean of end-of-day active admission bed counts / current bed capacity; historical bed capacity is not versioned.", admissions.length ? undefined : "No admission history overlaps this range."),
        averageLengthOfStay: metric(average(stayHours), "hours", stayHours.length, "Mean of dischargedAt - admittedAt for admissions discharged in the selected range."),
        averageDischargeProcessingTime: metric(average(dischargeHours), "hours", dischargeHours.length, "Mean of finalizedAt - discharge checklist createdAt for checklists finalized in the selected range."),
        averageLaboratoryTurnaround: metric(average(labHours), "hours", labHours.length, "Mean of LabResult.createdAt - LabOrder.createdAt for results created in the selected range."),
        averagePharmacyFulfillmentTime: metric(null, "hours", 0, "No pharmacy dispensing/fulfillment event is stored by the current application.", "Unavailable until dispensing timestamps are captured."),
        billingCollectionRate: financeRoles.includes(req.auth!.role as (typeof financeRoles)[number])
          ? metric(billed > 0 && collected !== undefined ? (collected / billed) * 100 : null, "percent", invoices?._count._all ?? 0, "For invoices issued in the range: (sum(total - current balance) / sum(total)) × 100; this is current settlement progress, not cash received during the range.", invoices?._count._all ? undefined : "No invoices were issued in this range.")
          : null,
      },
      departmentWorkload: departments,
      inventoryConsumption: inventory
        ? {
          status: inventory.length ? "available" : "unavailable",
          formula: "Sum of absolute negative InventoryTransaction.quantity grouped by transaction date; no dispensing is inferred from prescriptions.",
          dailyUnitsConsumed: inventory.map((item) => ({ date: dateKey(item.date), units: item.units })),
          transactionCount: inventory.reduce((sum, item) => sum + item.transactionCount, 0),
        }
        : { status: "unavailable", reason: "Inventory analytics require a pharmacy or administrator role." },
    };
    await prisma.auditLog.create({
      data: auditLogData(req, { action: "READ", entity: "PERFORMANCE_ANALYTICS", metadata: { startDate, endDate, departmentId: scope.departmentId } }),
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

export async function refreshOperationalAlerts(now = new Date()) {
  await prisma.operationalAlertRule.createMany({
    data: alertRuleDefinitions.map(({ key, category, severity, threshold }) => ({ key, category, severity, threshold })),
    skipDuplicates: true,
  });
  const [rules, bedCounts, departments] = await Promise.all([
    prisma.operationalAlertRule.findMany(),
    getBedCountsByDepartment(),
    prisma.department.findMany({ select: { id: true, name: true } }),
  ]);
  const ruleMap = new Map<string, (typeof rules)[number]>(rules.map((rule) => [rule.key, rule]));
  const getRule = (key: string) => ruleMap.get(key);
  const drafts: AlertDraft[] = [];
  const add = (input: Omit<AlertDraft, "category" | "severity"> & { severity?: IntelligenceAlertSeverity }) => {
    const rule = getRule(input.ruleKey);
    if (!rule?.enabled) return;
    drafts.push({
      ...input,
      category: rule.category,
      severity: input.severity ?? rule.severity,
      threshold: rule.threshold,
    });
  };
  const bedTotals = bedCounts.reduce(
    (total, item) => ({ total: total.total + item.total, occupied: total.occupied + item.occupied, available: total.available + item.available }),
    { total: 0, occupied: 0, available: 0 },
  );
  const occupancyScopes = [
    { id: undefined as string | undefined, label: "Hospital-wide", ...bedTotals },
    ...bedCounts.map((item) => ({ id: item.departmentId, label: departments.find((department) => department.id === item.departmentId)?.name ?? "Department", ...item })),
  ];
  for (const scope of occupancyScopes) {
    if (scope.total <= 0) continue;
    const percent = (scope.occupied / scope.total) * 100;
    const warningRule = getRule("BED_OCCUPANCY_WARNING");
    const criticalRule = getRule("BED_OCCUPANCY_CRITICAL");
    const occupancyRule = criticalRule?.enabled && percent >= criticalRule.threshold
      ? criticalRule
      : warningRule?.enabled && percent >= warningRule.threshold ? warningRule : undefined;
    if (occupancyRule) {
      add({
        ruleKey: occupancyRule.key,
        dedupeKey: `${occupancyRule.key}:${scope.id ?? "hospital"}`,
        title: `${scope.label} bed occupancy is high`,
        description: `${scope.occupied} of ${scope.total} beds are occupied (${percent.toFixed(1)}%). This is an operational threshold, not a capacity guarantee.`,
        departmentId: scope.id,
        metricValue: Number(percent.toFixed(2)),
      });
    }
    const shortageRule = getRule("BED_SHORTAGE");
    if (shortageRule?.enabled && scope.available <= shortageRule.threshold) {
      add({
        ruleKey: shortageRule.key,
        dedupeKey: `${shortageRule.key}:${scope.id ?? "hospital"}`,
        title: `${scope.label} has a critical bed shortage`,
        description: `${scope.available} beds are currently available; configured threshold is ${shortageRule.threshold}.`,
        departmentId: scope.id,
        metricValue: scope.available,
      });
    }
  }

  const lowDaysRule = getRule("INVENTORY_LOW_DAYS");
  const maxLookbackDays = 90;
  const since = new Date(now.getTime() - maxLookbackDays * oneDayMs);
  const [medicines, consumption, delayedTurnovers, delayedLabs, delayedDischarges, agedInvoices, workload] = await Promise.all([
    prisma.medicine.findMany({ select: { id: true, name: true, sku: true, quantity: true, reorderLevel: true, expiresAt: true } }),
    lowDaysRule?.enabled
      ? prisma.inventoryTransaction.findMany({
        where: { quantity: { lt: 0 }, createdAt: { gte: since, lt: now } },
        select: { medicineId: true, quantity: true, createdAt: true },
      })
      : Promise.resolve([]),
    getRule("BED_TURNOVER_DELAY_HOURS")?.enabled
      ? prisma.housekeepingTask.findMany({
        where: {
          type: HousekeepingTaskType.TERMINAL_CLEANING,
          status: { in: [HousekeepingTaskStatus.OPEN, HousekeepingTaskStatus.ASSIGNED, HousekeepingTaskStatus.IN_PROGRESS] },
          OR: [
            { createdAt: { lte: new Date(now.getTime() - (getRule("BED_TURNOVER_DELAY_HOURS")?.threshold ?? 4) * 3_600_000) } },
            { dueAt: { lte: now } },
          ],
        },
        select: { id: true, createdAt: true, dueAt: true, bed: { select: { ward: { select: { departmentId: true } } } } },
      })
      : Promise.resolve([]),
    getRule("LAB_PENDING_WARNING_HOURS")?.enabled || getRule("LAB_PENDING_CRITICAL_HOURS")?.enabled
      ? prisma.labOrder.findMany({
        where: { status: { not: LabStatus.COMPLETED }, createdAt: { lte: new Date(now.getTime() - (getRule("LAB_PENDING_WARNING_HOURS")?.threshold ?? 24) * 3_600_000) } },
        select: { createdAt: true, patient: { select: { departmentId: true } } },
      })
      : Promise.resolve([]),
    getRule("DISCHARGE_PENDING_HOURS")?.enabled
      ? prisma.dischargeChecklist.findMany({
        where: {
          approvedAt: { lte: new Date(now.getTime() - (getRule("DISCHARGE_PENDING_HOURS")?.threshold ?? 8) * 3_600_000) },
          finalizedAt: null,
          admission: { status: AdmissionStatus.ACTIVE },
        },
        select: { approvedAt: true, admission: { select: { patient: { select: { departmentId: true } } } } },
      })
      : Promise.resolve([]),
    getRule("PENDING_BILLING_DAYS")?.enabled
      ? prisma.invoice.findMany({
        where: { balance: { gt: 0 }, createdAt: { lte: new Date(now.getTime() - (getRule("PENDING_BILLING_DAYS")?.threshold ?? 30) * oneDayMs) } },
        select: { balance: true, patient: { select: { departmentId: true } } },
      })
      : Promise.resolve([]),
    getDepartmentWorkload({ start: utcDayStart(now), endExclusive: addUtcDays(utcDayStart(now), 1) }),
  ]);
  const departmentNames = new Map(departments.map((department) => [department.id, department.name]));
  const thresholdFor = (key: string) => getRule(key)?.threshold ?? 0;
  const consumptions = new Map<string, Array<{ quantity: number; createdAt: Date }>>();
  for (const item of consumption) {
    consumptions.set(item.medicineId, [...(consumptions.get(item.medicineId) ?? []), { quantity: Math.abs(item.quantity), createdAt: item.createdAt }]);
  }
  const expiryLimit = addUtcDays(utcDayStart(now), thresholdFor("MEDICINE_EXPIRY_DAYS"));
  for (const medicine of medicines) {
    const stockThreshold = Math.max(medicine.reorderLevel, thresholdFor("INVENTORY_LOW_UNITS"));
    if (medicine.quantity <= stockThreshold && getRule("INVENTORY_LOW_UNITS")?.enabled) {
      add({
        ruleKey: "INVENTORY_LOW_UNITS",
        dedupeKey: `INVENTORY_LOW_UNITS:${medicine.id}`,
        title: medicine.quantity <= 0 ? "Medicine is out of stock" : "Medicine stock is low",
        description: `${medicine.name} (${medicine.sku}) has ${medicine.quantity} units; configured minimum is ${stockThreshold}.`,
        severity: medicine.quantity <= 0 ? IntelligenceAlertSeverity.CRITICAL : undefined,
        metricValue: medicine.quantity,
      });
    }
    if (medicine.quantity > 0 && medicine.expiresAt < now && getRule("MEDICINE_EXPIRY_DAYS")?.enabled) {
      add({
        ruleKey: "MEDICINE_EXPIRY_DAYS",
        dedupeKey: `MEDICINE_EXPIRED:${medicine.id}`,
        title: "Stocked medicine has expired",
        description: `${medicine.name} (${medicine.sku}) is past its recorded expiry date.`,
        severity: IntelligenceAlertSeverity.CRITICAL,
        metricValue: Math.floor((medicine.expiresAt.getTime() - now.getTime()) / oneDayMs),
      });
    } else if (medicine.quantity > 0 && medicine.expiresAt <= expiryLimit && getRule("MEDICINE_EXPIRY_DAYS")?.enabled) {
      add({
        ruleKey: "MEDICINE_EXPIRY_DAYS",
        dedupeKey: `MEDICINE_EXPIRY_DAYS:${medicine.id}`,
        title: "Medicine is nearing expiry",
        description: `${medicine.name} (${medicine.sku}) expires within ${thresholdFor("MEDICINE_EXPIRY_DAYS")} days.`,
        metricValue: Math.ceil((medicine.expiresAt.getTime() - now.getTime()) / oneDayMs),
      });
    }
    if (lowDaysRule?.enabled) {
      const entries = consumptions.get(medicine.id) ?? [];
      const observedDates = new Set(entries.map((item) => dateKey(item.createdAt)));
      const earliest = entries.reduce<Date | null>((value, item) => !value || item.createdAt < value ? item.createdAt : value, null);
      const observedDays = earliest ? Math.max(1, Math.floor((now.getTime() - earliest.getTime()) / oneDayMs)) : 0;
      if (entries.length >= 3 && observedDates.size >= 3 && observedDays >= 14) {
        const dailyUse = entries.reduce((sum, item) => sum + item.quantity, 0) / observedDays;
        const remainingDays = dailyUse > 0 ? medicine.quantity / dailyUse : null;
        if (remainingDays !== null && remainingDays <= lowDaysRule.threshold) {
          add({
            ruleKey: lowDaysRule.key,
            dedupeKey: `${lowDaysRule.key}:${medicine.id}`,
            title: "Estimated medicine stock duration is low",
            description: `${medicine.name} has an estimated ${remainingDays.toFixed(1)} days of stock based only on recorded outbound transactions.`,
            metricValue: Number(remainingDays.toFixed(2)),
          });
        }
      }
    }
  }

  const turnoverByDepartment = new Map<string, number>();
  for (const task of delayedTurnovers) {
    const departmentId = task.bed?.ward.departmentId ?? "hospital";
    turnoverByDepartment.set(departmentId, (turnoverByDepartment.get(departmentId) ?? 0) + 1);
  }
  for (const [departmentId, count] of turnoverByDepartment) {
    const label = departmentId === "hospital" ? "Hospital-wide" : departmentNames.get(departmentId) ?? "Department";
    add({
      ruleKey: "BED_TURNOVER_DELAY_HOURS",
      dedupeKey: `BED_TURNOVER_DELAY_HOURS:${departmentId}`,
      title: `${label} has delayed bed turnover cleaning`,
      description: `${count} terminal-cleaning task(s) have exceeded the configured ${thresholdFor("BED_TURNOVER_DELAY_HOURS")}-hour threshold or their due time.`,
      departmentId: departmentId === "hospital" ? undefined : departmentId,
      metricValue: count,
    });
  }

  const labCounts = new Map<string, { count: number; oldestHours: number }>();
  for (const lab of delayedLabs) {
    const key = lab.patient.departmentId ?? "hospital";
    const ageHours = (now.getTime() - lab.createdAt.getTime()) / 3_600_000;
    const current = labCounts.get(key) ?? { count: 0, oldestHours: 0 };
    current.count++;
    current.oldestHours = Math.max(current.oldestHours, ageHours);
    labCounts.set(key, current);
  }
  for (const [departmentId, value] of labCounts) {
    const critical = getRule("LAB_PENDING_CRITICAL_HOURS")?.enabled
      && value.oldestHours >= thresholdFor("LAB_PENDING_CRITICAL_HOURS");
    const ruleKey = critical ? "LAB_PENDING_CRITICAL_HOURS" : "LAB_PENDING_WARNING_HOURS";
    add({
      ruleKey,
      dedupeKey: `${ruleKey}:${departmentId}`,
      title: `${departmentNames.get(departmentId) ?? "Hospital-wide"} has delayed laboratory orders`,
      description: `${value.count} pending order(s) exceed the warning threshold; the oldest is ${value.oldestHours.toFixed(1)} hours old.`,
      departmentId: departmentId === "hospital" ? undefined : departmentId,
      metricValue: Number(value.oldestHours.toFixed(2)),
    });
  }

  const dischargeCounts = new Map<string, { count: number; oldestHours: number }>();
  for (const item of delayedDischarges) {
    const departmentId = item.admission.patient.departmentId ?? "hospital";
    const ageHours = item.approvedAt ? (now.getTime() - item.approvedAt.getTime()) / 3_600_000 : 0;
    const current = dischargeCounts.get(departmentId) ?? { count: 0, oldestHours: 0 };
    current.count++;
    current.oldestHours = Math.max(current.oldestHours, ageHours);
    dischargeCounts.set(departmentId, current);
  }
  for (const [departmentId, value] of dischargeCounts) {
    add({
      ruleKey: "DISCHARGE_PENDING_HOURS",
      dedupeKey: `DISCHARGE_PENDING_HOURS:${departmentId}`,
      title: `${departmentNames.get(departmentId) ?? "Hospital-wide"} has delayed approved discharges`,
      description: `${value.count} approved discharge(s) remain unfinalized; the oldest is ${value.oldestHours.toFixed(1)} hours old.`,
      departmentId: departmentId === "hospital" ? undefined : departmentId,
      metricValue: Number(value.oldestHours.toFixed(2)),
    });
  }

  for (const item of workload) {
    if (item.workload === 0) continue;
    const ratio = item.onDutyDoctors > 0 ? item.workload / item.onDutyDoctors : null;
    if (ratio === null || ratio >= thresholdFor("DEPARTMENT_LOAD_PER_DOCTOR")) {
      add({
        ruleKey: "DEPARTMENT_LOAD_PER_DOCTOR",
        dedupeKey: `DEPARTMENT_LOAD_PER_DOCTOR:${item.departmentId}`,
        title: `${item.departmentName} has high operational workload`,
        description: ratio === null
          ? `${item.workload} appointments and active admissions are recorded with no on-duty doctor. This is an operational indicator, not a staffing recommendation.`
          : `${item.workload} appointments and active admissions across ${item.onDutyDoctors} on-duty doctor(s) (${ratio.toFixed(1)} items per doctor; threshold ${thresholdFor("DEPARTMENT_LOAD_PER_DOCTOR")}).`,
        departmentId: item.departmentId,
        metricValue: ratio ?? item.workload,
      });
    }
  }

  const invoiceCounts = new Map<string, { count: number; balance: number }>();
  for (const invoice of agedInvoices) {
    const departmentId = invoice.patient.departmentId ?? "hospital";
    const current = invoiceCounts.get(departmentId) ?? { count: 0, balance: 0 };
    current.count++;
    current.balance += Number(invoice.balance);
    invoiceCounts.set(departmentId, current);
  }
  for (const [departmentId, value] of invoiceCounts) {
    add({
      ruleKey: "PENDING_BILLING_DAYS",
      dedupeKey: `PENDING_BILLING_DAYS:${departmentId}`,
      title: `${departmentNames.get(departmentId) ?? "Hospital-wide"} has aged outstanding invoices`,
      description: `${value.count} invoice(s) remain outstanding after ${thresholdFor("PENDING_BILLING_DAYS")} days; aggregate balance ${value.balance.toFixed(2)}.`,
      departmentId: departmentId === "hospital" ? undefined : departmentId,
      metricValue: value.count,
    });
  }

  const activeKeys = new Set(drafts.map((draft) => draft.dedupeKey));
  const result = await prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext('mediverse-phase6-alert-engine')) AS locked`;
    if (!lock?.locked) return { skipped: true, created: 0, updated: 0, resolved: 0, active: 0 };
    const existing = await tx.operationalAlert.findMany({
      where: { dedupeKey: { not: null }, status: { in: [IntelligenceAlertStatus.OPEN, IntelligenceAlertStatus.ACKNOWLEDGED] } },
      select: { id: true, dedupeKey: true },
    });
    let resolved = 0;
    for (const alert of existing) {
      if (alert.dedupeKey && !activeKeys.has(alert.dedupeKey)) {
        const result = await tx.operationalAlert.updateMany({
          where: { id: alert.id, dedupeKey: alert.dedupeKey, status: { in: [IntelligenceAlertStatus.OPEN, IntelligenceAlertStatus.ACKNOWLEDGED] } },
          data: { status: IntelligenceAlertStatus.RESOLVED, dedupeKey: null, resolvedAt: now, resolvedById: null },
        });
        resolved += result.count;
      }
    }
    let created = 0;
    let updated = 0;
    for (const draft of drafts) {
      const current = await tx.operationalAlert.findUnique({ where: { dedupeKey: draft.dedupeKey } });
      if (current) {
        const changed = current.severity !== draft.severity
          || current.title !== draft.title
          || current.description !== draft.description
          || current.metricValue !== (draft.metricValue ?? null)
          || current.threshold !== (draft.threshold ?? null);
        if (changed) {
          await tx.operationalAlert.update({
            where: { id: current.id },
            data: {
              severity: draft.severity,
              title: draft.title,
              description: draft.description,
              metricValue: draft.metricValue,
              threshold: draft.threshold,
            },
          });
          updated++;
        }
      } else {
        await tx.operationalAlert.create({ data: draft });
        created++;
      }
    }
    const summary = { skipped: false, created, updated, resolved, active: drafts.length };
    if (created || updated || resolved) {
      await tx.auditLog.create({
        data: {
          action: "EVALUATE_OPERATIONAL_ALERTS",
          entity: "OPERATIONAL_ALERT",
          method: "SYSTEM",
          metadata: summary,
        },
      });
    }
    return summary;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return result;
}

intelligenceRouter.get("/intelligence/alert-rules", requireAuth, requireRole(...administrators), async (_req, res, next) => {
  try {
    await prisma.operationalAlertRule.createMany({
      data: alertRuleDefinitions.map(({ key, category, severity, threshold }) => ({ key, category, severity, threshold })),
      skipDuplicates: true,
    });
    const rules = await prisma.operationalAlertRule.findMany({ orderBy: [{ category: "asc" }, { key: "asc" }] });
    const definitions = new Map<string, (typeof alertRuleDefinitions)[number]>(
      alertRuleDefinitions.map((item): [string, (typeof alertRuleDefinitions)[number]] => [item.key, item]),
    );
    res.json({
      data: rules.map((rule) => ({
        ...rule,
        label: definitions.get(rule.key)?.label ?? rule.key,
        unit: definitions.get(rule.key)?.unit ?? "value",
        description: definitions.get(rule.key)?.description ?? "",
      })),
    });
  } catch (error) {
    next(error);
  }
});

intelligenceRouter.patch("/intelligence/alert-rules/:key", requireAuth, requireRole(...administrators), async (req: AuthenticatedRequest, res, next) => {
  try {
    const key = String(req.params.key);
    const definition = alertRuleDefinitions.find((item) => item.key === key);
    if (!definition) return fail(res, 404, "ALERT_RULE_NOT_FOUND", "The alert rule was not found.");
    const input = z.object({
      enabled: z.boolean().optional(),
      threshold: z.number().finite().min(0).max(10_000).optional(),
    }).refine((value) => value.enabled !== undefined || value.threshold !== undefined, "Provide enabled or threshold.").parse(req.body);
    if (input.threshold !== undefined && definition.unit === "percent" && input.threshold > 100) {
      return fail(res, 400, "INVALID_THRESHOLD", "Percentage thresholds cannot exceed 100.");
    }
    await prisma.operationalAlertRule.createMany({
      data: alertRuleDefinitions.map(({ key: ruleKey, category, severity, threshold }) => ({ key: ruleKey, category, severity, threshold })),
      skipDuplicates: true,
    });
    const updated = await prisma.$transaction(async (tx) => {
      const rule = await tx.operationalAlertRule.update({
        where: { key },
        data: { enabled: input.enabled, threshold: input.threshold, updatedById: req.auth!.userId },
      });
      await tx.auditLog.create({
        data: auditLogData(req, { action: "UPDATE_ALERT_RULE", entity: "OPERATIONAL_ALERT_RULE", entityId: key, metadata: { enabled: input.enabled, threshold: input.threshold } }),
      });
      return rule;
    });
    res.json({ data: { ...updated, label: definition.label, unit: definition.unit, description: definition.description } });
  } catch (error) {
    next(error);
  }
});

intelligenceRouter.post("/intelligence/alerts/refresh", requireAuth, requireRole(...administrators), async (req: AuthenticatedRequest, res, next) => {
  try {
    const result = await refreshOperationalAlerts();
    await prisma.auditLog.create({
      data: auditLogData(req, { action: "REFRESH_OPERATIONAL_ALERTS", entity: "OPERATIONAL_ALERT", metadata: result }),
    });
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

intelligenceRouter.get("/intelligence/alerts", requireAuth, requireRole(...analyticsRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      status: z.nativeEnum(IntelligenceAlertStatus).optional(),
      category: z.nativeEnum(IntelligenceAlertCategory).optional(),
      departmentId: z.string().min(1).max(64).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query);
    const scope = await getDepartmentScope(req, input.departmentId);
    if (scope.error) return fail(res, scope.error.status, scope.error.code, scope.error.message);
    if (input.category && !inScopeCategory(req.auth!.role, input.category)) {
      return fail(res, 403, "ALERT_CATEGORY_FORBIDDEN", "You do not have permission to view this alert category.");
    }
    const visibleCategories = Object.values(IntelligenceAlertCategory).filter((category) => inScopeCategory(req.auth!.role, category));
    const where: Prisma.OperationalAlertWhereInput = {
      category: input.category ? input.category : { in: visibleCategories },
      status: input.status ?? { in: [IntelligenceAlertStatus.OPEN, IntelligenceAlertStatus.ACKNOWLEDGED] },
      ...(scope.departmentId ? { departmentId: scope.departmentId } : {}),
    };
    const [items, total] = await prisma.$transaction([
      prisma.operationalAlert.findMany({
        where,
        skip: (input.page - 1) * input.limit,
        take: input.limit,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          ruleKey: true,
          category: true,
          severity: true,
          status: true,
          title: true,
          description: true,
          metricValue: true,
          threshold: true,
          createdAt: true,
          acknowledgedAt: true,
          resolvedAt: true,
          department: { select: { id: true, name: true } },
        },
      }),
      prisma.operationalAlert.count({ where }),
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.json({ data: { items, page: input.page, limit: input.limit, total } });
  } catch (error) {
    next(error);
  }
});

intelligenceRouter.patch("/intelligence/alerts/:id/acknowledge", requireAuth, requireRole(...analyticsRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const alert = await prisma.operationalAlert.findUnique({
      where: { id: String(req.params.id) },
      select: { id: true, category: true, status: true, departmentId: true },
    });
    if (!alert || !inScopeCategory(req.auth!.role, alert.category)) return fail(res, 404, "ALERT_NOT_FOUND", "The alert was not found.");
    const scope = await getDepartmentScope(req);
    if (scope.error) return fail(res, scope.error.status, scope.error.code, scope.error.message);
    if (scope.departmentId && alert.departmentId !== scope.departmentId) return fail(res, 404, "ALERT_NOT_FOUND", "The alert was not found.");
    if (alert.status === IntelligenceAlertStatus.RESOLVED) return fail(res, 409, "ALERT_ALREADY_RESOLVED", "A resolved alert cannot be acknowledged.");
    if (alert.status === IntelligenceAlertStatus.ACKNOWLEDGED) return res.json({ data: { acknowledged: true } });
    const updated = await prisma.$transaction(async (tx) => {
      const updated = await tx.operationalAlert.updateMany({
        where: { id: alert.id, status: IntelligenceAlertStatus.OPEN },
        data: { status: IntelligenceAlertStatus.ACKNOWLEDGED, acknowledgedAt: new Date(), acknowledgedById: req.auth!.userId },
      });
      if (updated.count === 1) {
        await tx.auditLog.create({ data: auditLogData(req, { action: "ACKNOWLEDGE_ALERT", entity: "OPERATIONAL_ALERT", entityId: alert.id }) });
      }
      return updated.count;
    });
    if (updated !== 1) {
      const current = await prisma.operationalAlert.findUnique({ where: { id: alert.id }, select: { status: true } });
      if (current?.status === IntelligenceAlertStatus.ACKNOWLEDGED) return res.json({ data: { acknowledged: true } });
      return fail(res, 409, "ALERT_STATE_CHANGED", "The alert changed before it could be acknowledged.");
    }
    res.json({ data: { acknowledged: true } });
  } catch (error) {
    next(error);
  }
});

intelligenceRouter.patch("/intelligence/alerts/:id/resolve", requireAuth, requireRole(...administrators), async (req: AuthenticatedRequest, res, next) => {
  try {
    const alert = await prisma.operationalAlert.findUnique({ where: { id: String(req.params.id) }, select: { id: true, status: true } });
    if (!alert) return fail(res, 404, "ALERT_NOT_FOUND", "The alert was not found.");
    if (alert.status === IntelligenceAlertStatus.RESOLVED) return res.json({ data: { resolved: true } });
    await prisma.$transaction(async (tx) => {
      await tx.operationalAlert.update({
        where: { id: alert.id },
        data: { status: IntelligenceAlertStatus.RESOLVED, dedupeKey: null, resolvedAt: new Date(), resolvedById: req.auth!.userId },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "RESOLVE_ALERT", entity: "OPERATIONAL_ALERT", entityId: alert.id }) });
    });
    res.json({ data: { resolved: true } });
  } catch (error) {
    next(error);
  }
});

const simulationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("bed_capacity"),
    admissionsPerDay: z.number().int().min(0).max(500),
    dischargesPerDay: z.number().int().min(0).max(500),
    horizonDays: z.number().int().min(1).max(30),
    departmentId: z.string().min(1).max(64).optional(),
  }),
  z.object({
    kind: z.literal("patient_flow"),
    dailyAppointments: z.number().int().min(0).max(10_000),
    availableClinicians: z.number().int().min(0).max(1_000),
    appointmentsPerClinician: z.number().int().min(1).max(100),
  }),
  z.object({
    kind: z.literal("staffing"),
    appointmentChangePercent: z.number().min(-100).max(200),
    staffingChangePercent: z.number().min(-100).max(200),
    departmentId: z.string().min(1).max(64).optional(),
  }),
]);

intelligenceRouter.post("/intelligence/simulations", requireAuth, requireRole(...analyticsRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = simulationSchema.parse(req.body);
    const requestedDepartmentId = input.kind === "patient_flow" ? undefined : input.departmentId;
    const scope = await getDepartmentScope(req, requestedDepartmentId);
    if (scope.error) return fail(res, scope.error.status, scope.error.code, scope.error.message);
    if (input.kind === "bed_capacity") {
      const beds = await getBedCounts(scope.departmentId);
      if (!beds.total) return fail(res, 409, "BED_DATA_UNAVAILABLE", "Bed capacity is not configured for this scope.");
      const projection = simulateBedCapacity({
        currentOccupancy: beds.occupied,
        totalBeds: beds.total,
        admissionsPerDay: input.admissionsPerDay,
        dischargesPerDay: input.dischargesPerDay,
        horizonDays: input.horizonDays,
      });
      return res.json({
        data: {
          kind: input.kind,
          hypothetical: true,
          baseline: { occupiedBeds: beds.occupied, totalBeds: beds.total },
          assumptions: ["The current occupied-bed count is the scenario starting point.", "Daily admission and discharge volumes remain constant.", "Scenario results do not alter hospital records."],
          projection,
        },
      });
    }
    if (input.kind === "patient_flow") {
      return res.json({
        data: {
          kind: input.kind,
          hypothetical: true,
          assumptions: ["Every clinician has the same user-supplied daily appointment capacity.", "No historical or real appointment record is changed."],
          result: simulatePatientFlow(input),
        },
      });
    }
    const today = utcDayStart(new Date());
    const departments = await getDepartmentWorkload({ start: today, endExclusive: addUtcDays(today, 1), departmentId: scope.departmentId });
    return res.json({
      data: {
        kind: input.kind,
        hypothetical: true,
        assumptions: ["Baseline workload is today's non-cancelled appointments plus active admissions.", "On-duty doctor counts are the baseline staffing level.", "Percentage changes are hypothetical and do not change staffing or appointments."],
        result: simulateStaffing({
          departments,
          appointmentChangePercent: input.appointmentChangePercent,
          staffingChangePercent: input.staffingChangePercent,
          overloadThreshold: 8,
        }),
      },
    });
  } catch (error) {
    next(error);
  }
});
