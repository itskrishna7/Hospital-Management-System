import { Router, type Response } from "express";
import {
  AmbulanceDispatchStatus,
  AmbulanceStatus,
  AppointmentStatus,
  BloodComponent,
  BloodGroup,
  BloodUnitStatus,
  EquipmentMaintenanceStatus,
  EquipmentStatus,
  HousekeepingTaskStatus,
  HousekeepingTaskType,
  ImagingModality,
  ImagingOrderStatus,
  InsuranceClaimStatus,
  InvoiceStatus,
  LabStatus,
  OperationsPriority,
  PaymentMethod,
  Prisma,
  ProcedureCaseStatus,
  QueueEntryStatus,
  Role,
} from "@prisma/client";
import { z } from "zod";
import { auditLogData, requireAuth, requireRole, type AuthenticatedRequest } from "./auth.js";
import { prisma } from "./db.js";

export const operationsRouter = Router();

const administrators = [Role.SUPER_ADMIN, Role.HOSPITAL_ADMIN, Role.ADMIN] as const;
const financeRoles = [...administrators, Role.BILLING_STAFF, Role.ACCOUNTANT] as const;
const radiologyRoles = [...administrators, Role.DOCTOR, Role.RADIOLOGIST] as const;
const otRoles = [...administrators, Role.DOCTOR] as const;
const bloodBankRoles = [...administrators, Role.LAB_TECHNICIAN] as const;
const ambulanceDeskRoles = [...administrators, Role.RECEPTIONIST] as const;
const dispatchRoles = [...ambulanceDeskRoles, Role.DOCTOR, Role.NURSE] as const;
const equipmentRoles = [...administrators, Role.HOUSEKEEPING] as const;
const housekeepingRoles = [...administrators, Role.HOUSEKEEPING] as const;
const operationsReaderRoles = [
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
const claimApprovalStates = new Set<InsuranceClaimStatus>([
  InsuranceClaimStatus.APPROVED,
  InsuranceClaimStatus.PARTIALLY_APPROVED,
  InsuranceClaimStatus.PAID,
]);
const stockAvailableStatuses = new Set<BloodUnitStatus>([
  BloodUnitStatus.AVAILABLE,
  BloodUnitStatus.RESERVED,
  BloodUnitStatus.ISSUED,
]);
const maxMoney = new Prisma.Decimal("9999999999.99");

const moneyInput = z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/, "Enter an amount with at most two decimal places.");
const asMoney = (value: string) => new Prisma.Decimal(value);
const paramsId = (req: AuthenticatedRequest) => String(req.params.id);
const includePatient = { patient: { select: { id: true, patientNumber: true, firstName: true, lastName: true } } };

function fail(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message } });
}

function statusFromBalance(balance: Prisma.Decimal, total: Prisma.Decimal): InvoiceStatus {
  if (balance.isZero()) return InvoiceStatus.PAID;
  return balance.equals(total) ? InvoiceStatus.UNPAID : InvoiceStatus.PARTIAL;
}

async function doctorScope(userId: string) {
  return prisma.doctor.findUnique({ where: { userId }, select: { id: true, departmentId: true } });
}

async function patientAccess(userId: string, role: Role, patientId: string) {
  const patient = await prisma.patient.findUnique({ where: { id: patientId }, select: { id: true, departmentId: true } });
  if (!patient) return "PATIENT_NOT_FOUND";
  if (role === Role.DOCTOR) {
    const doctor = await doctorScope(userId);
    if (!doctor) return "DOCTOR_PROFILE_REQUIRED";
    if (doctor.departmentId !== patient.departmentId) return "PATIENT_NOT_FOUND";
  }
  if (role === Role.NURSE) {
    const activeAdmission = await prisma.admission.findFirst({ where: { patientId, status: "ACTIVE" }, select: { id: true } });
    if (!activeAdmission) return "PATIENT_NOT_FOUND";
  }
  return "ALLOWED";
}

function canTransition<T extends string>(current: T, next: T, transitions: Record<T, readonly T[]>) {
  return transitions[current]?.includes(next) ?? false;
}

const claimTransitions: Record<InsuranceClaimStatus, readonly InsuranceClaimStatus[]> = {
  DRAFT: [InsuranceClaimStatus.SUBMITTED, InsuranceClaimStatus.CANCELLED],
  SUBMITTED: [InsuranceClaimStatus.IN_REVIEW, InsuranceClaimStatus.CANCELLED],
  IN_REVIEW: [InsuranceClaimStatus.APPROVED, InsuranceClaimStatus.PARTIALLY_APPROVED, InsuranceClaimStatus.DENIED, InsuranceClaimStatus.CANCELLED],
  APPROVED: [InsuranceClaimStatus.PAID],
  PARTIALLY_APPROVED: [InsuranceClaimStatus.PAID],
  DENIED: [],
  PAID: [],
  CANCELLED: [],
};
const imagingTransitions: Record<ImagingOrderStatus, readonly ImagingOrderStatus[]> = {
  REQUESTED: [ImagingOrderStatus.SCHEDULED, ImagingOrderStatus.IN_PROGRESS, ImagingOrderStatus.CANCELLED],
  SCHEDULED: [ImagingOrderStatus.IN_PROGRESS, ImagingOrderStatus.CANCELLED],
  IN_PROGRESS: [ImagingOrderStatus.CANCELLED],
  COMPLETED: [],
  CANCELLED: [],
};
const procedureTransitions: Record<ProcedureCaseStatus, readonly ProcedureCaseStatus[]> = {
  PLANNED: [ProcedureCaseStatus.SCHEDULED, ProcedureCaseStatus.CANCELLED],
  SCHEDULED: [ProcedureCaseStatus.IN_PROGRESS, ProcedureCaseStatus.CANCELLED],
  IN_PROGRESS: [ProcedureCaseStatus.COMPLETED],
  COMPLETED: [],
  CANCELLED: [],
};
const bloodTransitions: Record<BloodUnitStatus, readonly BloodUnitStatus[]> = {
  AVAILABLE: [BloodUnitStatus.RESERVED, BloodUnitStatus.QUARANTINED, BloodUnitStatus.DISCARDED],
  RESERVED: [BloodUnitStatus.AVAILABLE, BloodUnitStatus.ISSUED, BloodUnitStatus.QUARANTINED, BloodUnitStatus.DISCARDED],
  ISSUED: [BloodUnitStatus.RETURNED, BloodUnitStatus.QUARANTINED],
  RETURNED: [BloodUnitStatus.QUARANTINED, BloodUnitStatus.DISCARDED],
  QUARANTINED: [BloodUnitStatus.DISCARDED],
  DISCARDED: [],
};
const dispatchTransitions: Record<AmbulanceDispatchStatus, readonly AmbulanceDispatchStatus[]> = {
  REQUESTED: [AmbulanceDispatchStatus.DISPATCHED, AmbulanceDispatchStatus.CANCELLED],
  DISPATCHED: [AmbulanceDispatchStatus.EN_ROUTE, AmbulanceDispatchStatus.CANCELLED],
  EN_ROUTE: [AmbulanceDispatchStatus.ARRIVED, AmbulanceDispatchStatus.CANCELLED],
  ARRIVED: [AmbulanceDispatchStatus.COMPLETED],
  COMPLETED: [],
  CANCELLED: [],
};
const maintenanceTransitions: Record<EquipmentMaintenanceStatus, readonly EquipmentMaintenanceStatus[]> = {
  OPEN: [EquipmentMaintenanceStatus.IN_PROGRESS, EquipmentMaintenanceStatus.CANCELLED],
  IN_PROGRESS: [EquipmentMaintenanceStatus.COMPLETED, EquipmentMaintenanceStatus.CANCELLED],
  COMPLETED: [],
  CANCELLED: [],
};
const housekeepingTransitions: Record<HousekeepingTaskStatus, readonly HousekeepingTaskStatus[]> = {
  OPEN: [HousekeepingTaskStatus.ASSIGNED, HousekeepingTaskStatus.CANCELLED],
  ASSIGNED: [HousekeepingTaskStatus.IN_PROGRESS, HousekeepingTaskStatus.CANCELLED],
  IN_PROGRESS: [HousekeepingTaskStatus.COMPLETED, HousekeepingTaskStatus.CANCELLED],
  COMPLETED: [],
  CANCELLED: [],
};

operationsRouter.get("/operations/twin", requireAuth, requireRole(...operationsReaderRoles), async (_req, res, next) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const [
      totalBeds,
      occupiedBeds,
      availableBeds,
      activeAdmissions,
      appointmentsToday,
      pendingLabs,
      activeQueue,
      openHousekeepingTasks,
      availableAmbulances,
      activeDispatches,
    ] = await Promise.all([
      prisma.bed.count(),
      prisma.bed.count({ where: { status: "OCCUPIED" } }),
      prisma.bed.count({ where: { status: "AVAILABLE" } }),
      prisma.admission.count({ where: { status: "ACTIVE" } }),
      prisma.appointment.count({ where: { startsAt: { gte: startOfDay }, status: { not: AppointmentStatus.CANCELLED } } }),
      prisma.labOrder.count({ where: { status: { not: LabStatus.COMPLETED } } }),
      prisma.queueEntry.count({ where: { status: { in: [QueueEntryStatus.WAITING, QueueEntryStatus.CALLED, QueueEntryStatus.IN_PROGRESS] } } }),
      prisma.housekeepingTask.count({ where: { status: { notIn: ["COMPLETED", "CANCELLED"] } } }),
      prisma.ambulance.count({ where: { status: "AVAILABLE" } }),
      prisma.ambulanceDispatch.count({ where: { status: { notIn: ["COMPLETED", "CANCELLED"] } } }),
    ]);
    res.json({
      data: {
        totalBeds,
        occupiedBeds,
        availableBeds,
        activeAdmissions,
        appointmentsToday,
        pendingLabs,
        activeQueue,
        openHousekeepingTasks,
        availableAmbulances,
        activeDispatches,
        occupancyPercent: totalBeds ? Math.round((occupiedBeds / totalBeds) * 100) : 0,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

operationsRouter.get("/operations/patients", requireAuth, requireRole(...financeRoles, ...radiologyRoles, ...otRoles, Role.RECEPTIONIST, Role.NURSE), async (req: AuthenticatedRequest, res, next) => {
  try {
    const doctor = req.auth!.role === Role.DOCTOR ? await doctorScope(req.auth!.userId) : null;
    if (req.auth!.role === Role.DOCTOR && !doctor) return fail(res, 403, "DOCTOR_PROFILE_REQUIRED", "A doctor profile is required for this resource.");
    const patients = await prisma.patient.findMany({
      where: doctor ? { departmentId: doctor.departmentId } : undefined,
      select: { id: true, patientNumber: true, firstName: true, lastName: true, departmentId: true },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: 200,
    });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "PATIENT", metadata: { module: "PHASE4", count: patients.length } }) });
    res.json({ data: patients });
  } catch (error) {
    next(error);
  }
});

operationsRouter.get("/operations/doctors", requireAuth, requireRole(...otRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const ownDoctor = req.auth!.role === Role.DOCTOR ? await doctorScope(req.auth!.userId) : null;
    if (req.auth!.role === Role.DOCTOR && !ownDoctor) return fail(res, 403, "DOCTOR_PROFILE_REQUIRED", "A doctor profile is required for this resource.");
    const doctors = await prisma.doctor.findMany({
      where: ownDoctor ? { id: ownDoctor.id, user: { active: true } } : { user: { active: true } },
      select: { id: true, specialty: true, department: { select: { name: true } }, user: { select: { name: true } } },
      orderBy: { user: { name: "asc" } },
    });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "DOCTOR", metadata: { module: "PHASE4", count: doctors.length } }) });
    res.json({ data: doctors });
  } catch (error) {
    next(error);
  }
});

operationsRouter.get("/operations/invoices", requireAuth, requireRole(...financeRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const invoices = await prisma.invoice.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        ...includePatient,
        items: true,
        payments: { include: { refunds: true }, orderBy: { createdAt: "desc" } },
      },
    });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "INVOICE", metadata: { count: invoices.length } }) });
    res.json({ data: invoices });
  } catch (error) {
    next(error);
  }
});

operationsRouter.post("/operations/invoices", requireAuth, requireRole(...financeRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      patientId: z.string().min(1),
      tax: moneyInput.default("0"),
      items: z.array(z.object({
        description: z.string().trim().min(1).max(200),
        quantity: z.number().int().positive().max(100_000),
        unitPrice: moneyInput,
      })).min(1).max(100),
    }).parse(req.body);
    if (!await prisma.patient.findUnique({ where: { id: input.patientId }, select: { id: true } })) {
      return fail(res, 404, "PATIENT_NOT_FOUND", "The requested patient was not found.");
    }
    const subtotal = input.items.reduce((sum, item) => sum.plus(asMoney(item.unitPrice).mul(item.quantity)), new Prisma.Decimal(0)).toDecimalPlaces(2);
    const tax = asMoney(input.tax);
    const total = subtotal.plus(tax).toDecimalPlaces(2);
    if (subtotal.gt(maxMoney) || tax.gt(maxMoney) || total.gt(maxMoney)) {
      return fail(res, 400, "INVOICE_TOTAL_INVALID", "Invoice amounts exceed the supported maximum.");
    }
    if (total.lte(0)) return fail(res, 400, "INVOICE_TOTAL_INVALID", "The invoice total must be greater than zero.");
    const invoice = await prisma.$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: {
          patientId: input.patientId,
          subtotal,
          tax,
          total,
          balance: total,
          items: { create: input.items.map((item) => ({ ...item, unitPrice: asMoney(item.unitPrice) })) },
        },
        include: { ...includePatient, items: true },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE", entity: "INVOICE", entityId: created.id, metadata: { total: total.toFixed(2), itemCount: input.items.length } }) });
      return created;
    });
    res.status(201).json({ data: invoice });
  } catch (error) {
    next(error);
  }
});

operationsRouter.post("/operations/invoices/:id/payments", requireAuth, requireRole(...financeRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      amount: moneyInput,
      reference: z.string().trim().min(3).max(120),
      method: z.nativeEnum(PaymentMethod),
    }).parse(req.body);
    const amount = asMoney(input.amount);
    if (amount.lte(0)) return fail(res, 400, "PAYMENT_AMOUNT_INVALID", "The payment amount must be greater than zero.");
    const outcome = await prisma.$transaction(async (tx) => {
      const invoiceId = paramsId(req);
      const invoice = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { id: true, total: true, balance: true } });
      if (!invoice) return { error: "NOT_FOUND" as const };
      if (amount.gt(invoice.balance)) return { error: "OVERPAYMENT" as const };
      const nextBalance = invoice.balance.minus(amount).toDecimalPlaces(2);
      const updated = await tx.invoice.updateMany({
        where: { id: invoiceId, balance: invoice.balance },
        data: { balance: nextBalance, status: statusFromBalance(nextBalance, invoice.total) },
      });
      if (updated.count !== 1) return { error: "CONCURRENT_UPDATE" as const };
      const payment = await tx.payment.create({
        data: { invoiceId, amount, reference: input.reference, method: input.method, simulated: true },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "RECORD_MANUAL_PAYMENT", entity: "PAYMENT", entityId: payment.id, metadata: { invoiceId, amount: amount.toFixed(2), method: input.method } }) });
      return { payment, balance: nextBalance.toFixed(2) };
    });
    if ("error" in outcome) {
      if (outcome.error === "NOT_FOUND") return fail(res, 404, "INVOICE_NOT_FOUND", "The requested invoice was not found.");
      if (outcome.error === "OVERPAYMENT") return fail(res, 409, "PAYMENT_EXCEEDS_BALANCE", "The payment exceeds the invoice balance.");
      return fail(res, 409, "INVOICE_CHANGED", "The invoice changed during payment recording. Refresh and retry.");
    }
    res.status(201).json({ data: outcome });
  } catch (error) {
    next(error);
  }
});

operationsRouter.post("/operations/payments/:id/refunds", requireAuth, requireRole(...financeRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      amount: moneyInput,
      reference: z.string().trim().min(3).max(120),
      reason: z.string().trim().min(5).max(500),
    }).parse(req.body);
    const amount = asMoney(input.amount);
    if (amount.lte(0)) return fail(res, 400, "REFUND_AMOUNT_INVALID", "The refund amount must be greater than zero.");
    const outcome = await prisma.$transaction(async (tx) => {
      const paymentId = paramsId(req);
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${paymentId} FOR UPDATE`;
      const payment = await tx.payment.findUnique({ where: { id: paymentId }, include: { invoice: true } });
      if (!payment) return { error: "NOT_FOUND" as const };
      const priorRefunds = await tx.refund.aggregate({ where: { paymentId }, _sum: { amount: true } });
      const refundable = payment.amount.minus(priorRefunds._sum.amount ?? new Prisma.Decimal(0));
      if (amount.gt(refundable)) return { error: "EXCEEDS_PAYMENT" as const };
      const nextBalance = payment.invoice.balance.plus(amount).toDecimalPlaces(2);
      if (nextBalance.gt(payment.invoice.total)) return { error: "EXCEEDS_INVOICE" as const };
      const changed = await tx.invoice.updateMany({
        where: { id: payment.invoiceId, balance: payment.invoice.balance },
        data: { balance: nextBalance, status: statusFromBalance(nextBalance, payment.invoice.total) },
      });
      if (changed.count !== 1) return { error: "CONCURRENT_UPDATE" as const };
      const refund = await tx.refund.create({ data: { paymentId, amount, reference: input.reference, reason: input.reason } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "RECORD_MANUAL_REFUND", entity: "REFUND", entityId: refund.id, metadata: { paymentId, amount: amount.toFixed(2) } }) });
      return { refund, balance: nextBalance.toFixed(2) };
    });
    if ("error" in outcome) {
      if (outcome.error === "NOT_FOUND") return fail(res, 404, "PAYMENT_NOT_FOUND", "The requested payment was not found.");
      if (outcome.error === "EXCEEDS_PAYMENT" || outcome.error === "EXCEEDS_INVOICE") return fail(res, 409, "REFUND_EXCEEDS_PAID_AMOUNT", "The refund exceeds the remaining amount paid.");
      return fail(res, 409, "INVOICE_CHANGED", "The invoice changed during refund recording. Refresh and retry.");
    }
    res.status(201).json({ data: outcome });
  } catch (error) {
    next(error);
  }
});

operationsRouter.get("/operations/insurance/policies", requireAuth, requireRole(...financeRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const policies = await prisma.insurancePolicy.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: includePatient,
    });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "INSURANCE_POLICY", metadata: { count: policies.length } }) });
    res.json({ data: policies });
  } catch (error) {
    next(error);
  }
});

operationsRouter.post("/operations/insurance/policies", requireAuth, requireRole(...financeRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      patientId: z.string().min(1),
      payerName: z.string().trim().min(1).max(120),
      policyNumber: z.string().trim().min(1).max(120),
      memberNumber: z.string().trim().max(120).optional(),
      validFrom: z.coerce.date(),
      validUntil: z.coerce.date().optional(),
    }).parse(req.body);
    if (input.validUntil && input.validUntil < input.validFrom) return fail(res, 400, "POLICY_DATES_INVALID", "Policy expiry must be after its start date.");
    if (!await prisma.patient.findUnique({ where: { id: input.patientId }, select: { id: true } })) {
      return fail(res, 404, "PATIENT_NOT_FOUND", "The requested patient was not found.");
    }
    const policy = await prisma.$transaction(async (tx) => {
      const created = await tx.insurancePolicy.create({ data: input, include: includePatient });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE", entity: "INSURANCE_POLICY", entityId: created.id }) });
      return created;
    });
    res.status(201).json({ data: policy });
  } catch (error) {
    next(error);
  }
});

operationsRouter.patch("/operations/insurance/policies/:id/status", requireAuth, requireRole(...financeRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const id = paramsId(req);
    const policy = await prisma.$transaction(async (tx) => {
      const updated = await tx.insurancePolicy.update({ where: { id }, data: { active } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE_STATUS", entity: "INSURANCE_POLICY", entityId: id, metadata: { active } }) });
      return updated;
    });
    res.json({ data: policy });
  } catch (error) {
    next(error);
  }
});

operationsRouter.get("/operations/insurance/claims", requireAuth, requireRole(...financeRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const claims = await prisma.insuranceClaim.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { invoice: { include: includePatient }, policy: true },
    });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "INSURANCE_CLAIM", metadata: { count: claims.length } }) });
    res.json({ data: claims });
  } catch (error) {
    next(error);
  }
});

operationsRouter.post("/operations/insurance/claims", requireAuth, requireRole(...financeRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      invoiceId: z.string().min(1),
      policyId: z.string().min(1),
      claimNumber: z.string().trim().min(1).max(120),
      requestedAmount: moneyInput,
      notes: z.string().trim().max(2000).optional(),
    }).parse(req.body);
    const requestedAmount = asMoney(input.requestedAmount);
    if (requestedAmount.lte(0) || requestedAmount.gt(maxMoney)) return fail(res, 400, "CLAIM_AMOUNT_INVALID", "The claim amount is outside the supported range.");
    const invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId }, select: { patientId: true, total: true } });
    const policy = await prisma.insurancePolicy.findUnique({ where: { id: input.policyId } });
    if (!invoice || !policy || invoice.patientId !== policy.patientId) return fail(res, 404, "CLAIM_LINK_NOT_FOUND", "The invoice and active policy must belong to the same patient.");
    const now = new Date();
    if (!policy.active || policy.validFrom > now || (policy.validUntil && policy.validUntil < now)) {
      return fail(res, 409, "POLICY_NOT_ACTIVE", "The selected insurance policy is not active for today's date.");
    }
    if (requestedAmount.gt(invoice.total)) return fail(res, 400, "CLAIM_EXCEEDS_INVOICE", "The requested claim amount cannot exceed the invoice total.");
    const claim = await prisma.$transaction(async (tx) => {
      const created = await tx.insuranceClaim.create({ data: { ...input, requestedAmount, status: InsuranceClaimStatus.DRAFT } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE", entity: "INSURANCE_CLAIM", entityId: created.id, metadata: { requestedAmount: requestedAmount.toFixed(2) } }) });
      return created;
    });
    res.status(201).json({ data: claim });
  } catch (error) {
    next(error);
  }
});

operationsRouter.patch("/operations/insurance/claims/:id/status", requireAuth, requireRole(...financeRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      status: z.nativeEnum(InsuranceClaimStatus),
      approvedAmount: moneyInput.optional(),
      notes: z.string().trim().max(2000).optional(),
    }).parse(req.body);
    const claimId = paramsId(req);
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "InsuranceClaim" WHERE id = ${claimId} FOR UPDATE`;
      const claim = await tx.insuranceClaim.findUnique({ where: { id: claimId } });
      if (!claim) return { error: "NOT_FOUND" as const };
      if (!canTransition(claim.status, input.status, claimTransitions)) return { error: "INVALID_TRANSITION" as const };
      const approvedAmount = input.approvedAmount ? asMoney(input.approvedAmount) : claim.approvedAmount;
      if (claimApprovalStates.has(input.status) && !approvedAmount) {
        return { error: "APPROVAL_AMOUNT_REQUIRED" as const };
      }
      if (approvedAmount && (approvedAmount.lt(0) || approvedAmount.gt(claim.requestedAmount))) return { error: "APPROVAL_AMOUNT_INVALID" as const };
      if (input.status === InsuranceClaimStatus.APPROVED && approvedAmount && !approvedAmount.equals(claim.requestedAmount)) {
        return { error: "APPROVAL_AMOUNT_INVALID" as const };
      }
      if (input.status === InsuranceClaimStatus.PARTIALLY_APPROVED && approvedAmount && (approvedAmount.isZero() || approvedAmount.equals(claim.requestedAmount))) {
        return { error: "APPROVAL_AMOUNT_INVALID" as const };
      }
      const updated = await tx.insuranceClaim.update({
        where: { id: claimId },
        data: {
          status: input.status,
          approvedAmount: approvedAmount ?? undefined,
          notes: input.notes,
          submittedAt: input.status === InsuranceClaimStatus.SUBMITTED ? new Date() : undefined,
        },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE_STATUS", entity: "INSURANCE_CLAIM", entityId: updated.id, metadata: { status: input.status } }) });
      return { claim: updated };
    });
    if ("error" in result) {
      if (result.error === "NOT_FOUND") return fail(res, 404, "CLAIM_NOT_FOUND", "The insurance claim was not found.");
      if (result.error === "INVALID_TRANSITION") return fail(res, 409, "CLAIM_TRANSITION_INVALID", "That claim status transition is not allowed.");
      if (result.error === "APPROVAL_AMOUNT_REQUIRED") return fail(res, 400, result.error, "An approved amount is required before approval or payment.");
      return fail(res, 400, "APPROVAL_AMOUNT_INVALID", "The approved amount must match the requested amount and status.");
    }
    res.json({ data: result.claim });
  } catch (error) {
    next(error);
  }
});

operationsRouter.get("/operations/radiology/orders", requireAuth, requireRole(...radiologyRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const doctor = req.auth!.role === Role.DOCTOR ? await doctorScope(req.auth!.userId) : null;
    if (req.auth!.role === Role.DOCTOR && !doctor) return fail(res, 403, "DOCTOR_PROFILE_REQUIRED", "A doctor profile is required for this resource.");
    const orders = await prisma.imagingOrder.findMany({
      where: doctor ? { patient: { departmentId: doctor.departmentId } } : undefined,
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { ...includePatient, orderedBy: { select: { name: true } }, reportedBy: { select: { name: true } } },
    });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "IMAGING_ORDER", metadata: { count: orders.length } }) });
    res.json({ data: orders });
  } catch (error) {
    next(error);
  }
});

operationsRouter.post("/operations/radiology/orders", requireAuth, requireRole(...administrators, Role.DOCTOR), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      patientId: z.string().min(1),
      modality: z.nativeEnum(ImagingModality),
      bodySite: z.string().trim().min(1).max(120),
      clinicalIndication: z.string().trim().min(1).max(1000),
    }).parse(req.body);
    const access = await patientAccess(req.auth!.userId, req.auth!.role, input.patientId);
    if (access === "DOCTOR_PROFILE_REQUIRED") return fail(res, 403, access, "A doctor profile is required for this resource.");
    if (access !== "ALLOWED") return fail(res, 404, access, "The requested patient was not found.");
    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.imagingOrder.create({ data: { ...input, orderedById: req.auth!.userId }, include: includePatient });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE", entity: "IMAGING_ORDER", entityId: created.id, metadata: { modality: input.modality } }) });
      return created;
    });
    res.status(201).json({ data: order });
  } catch (error) {
    next(error);
  }
});

operationsRouter.patch("/operations/radiology/orders/:id/status", requireAuth, requireRole(...administrators, Role.RADIOLOGIST), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ status: z.nativeEnum(ImagingOrderStatus), scheduledAt: z.coerce.date().optional() }).parse(req.body);
    if (input.status === ImagingOrderStatus.COMPLETED) return fail(res, 400, "REPORT_REQUIRED", "Complete an imaging order by submitting its report.");
    const id = paramsId(req);
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ImagingOrder" WHERE id = ${id} FOR UPDATE`;
      const current = await tx.imagingOrder.findUnique({ where: { id } });
      if (!current) return { error: "NOT_FOUND" as const };
      if (!canTransition(current.status, input.status, imagingTransitions)) return { error: "INVALID_TRANSITION" as const };
      if (input.status === ImagingOrderStatus.SCHEDULED && !input.scheduledAt && !current.scheduledAt) return { error: "SCHEDULE_TIME_REQUIRED" as const };
      const updated = await tx.imagingOrder.update({
        where: { id },
        data: { status: input.status, scheduledAt: input.scheduledAt ?? current.scheduledAt },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE_STATUS", entity: "IMAGING_ORDER", entityId: id, metadata: { status: input.status } }) });
      return { order: updated };
    });
    if ("error" in outcome) {
      return outcome.error === "NOT_FOUND"
        ? fail(res, 404, "IMAGING_ORDER_NOT_FOUND", "The imaging order was not found.")
        : outcome.error === "SCHEDULE_TIME_REQUIRED"
          ? fail(res, 400, "SCHEDULE_TIME_REQUIRED", "Provide a scheduled time before marking the order scheduled.")
        : fail(res, 409, "IMAGING_TRANSITION_INVALID", "That imaging status transition is not allowed.");
    }
    res.json({ data: outcome.order });
  } catch (error) {
    next(error);
  }
});

operationsRouter.patch("/operations/radiology/orders/:id/report", requireAuth, requireRole(...administrators, Role.RADIOLOGIST), async (req: AuthenticatedRequest, res, next) => {
  try {
    const { report } = z.object({ report: z.string().trim().min(1).max(20_000) }).parse(req.body);
    const id = paramsId(req);
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ImagingOrder" WHERE id = ${id} FOR UPDATE`;
      const order = await tx.imagingOrder.findUnique({ where: { id } });
      if (!order) return { error: "NOT_FOUND" as const };
      if (order.status !== ImagingOrderStatus.IN_PROGRESS) return { error: "NOT_IN_PROGRESS" as const };
      const updated = await tx.imagingOrder.update({
        where: { id },
        data: { report, status: ImagingOrderStatus.COMPLETED, reportedById: req.auth!.userId },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "REPORT", entity: "IMAGING_ORDER", entityId: id }) });
      return { order: updated };
    });
    if ("error" in outcome) {
      return outcome.error === "NOT_FOUND"
        ? fail(res, 404, "IMAGING_ORDER_NOT_FOUND", "The imaging order was not found.")
        : fail(res, 409, "IMAGING_ORDER_NOT_IN_PROGRESS", "Only an in-progress imaging order can be reported.");
    }
    res.json({ data: outcome.order });
  } catch (error) {
    next(error);
  }
});

operationsRouter.get("/operations/ot/rooms", requireAuth, requireRole(...otRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const rooms = await prisma.operatingRoom.findMany({ orderBy: { code: "asc" } });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "OPERATING_ROOM", metadata: { count: rooms.length } }) });
    res.json({ data: rooms });
  } catch (error) {
    next(error);
  }
});

operationsRouter.post("/operations/ot/rooms", requireAuth, requireRole(...administrators), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ code: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(120) }).parse(req.body);
    const room = await prisma.$transaction(async (tx) => {
      const created = await tx.operatingRoom.create({ data: input });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE", entity: "OPERATING_ROOM", entityId: created.id }) });
      return created;
    });
    res.status(201).json({ data: room });
  } catch (error) {
    next(error);
  }
});

operationsRouter.get("/operations/ot/cases", requireAuth, requireRole(...otRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const doctor = req.auth!.role === Role.DOCTOR ? await doctorScope(req.auth!.userId) : null;
    if (req.auth!.role === Role.DOCTOR && !doctor) return fail(res, 403, "DOCTOR_PROFILE_REQUIRED", "A doctor profile is required for this resource.");
    const cases = await prisma.procedureCase.findMany({
      where: doctor ? { surgeonId: doctor.id } : undefined,
      orderBy: { startsAt: "asc" },
      take: 200,
      include: { ...includePatient, surgeon: { include: { user: { select: { name: true } } } }, room: true },
    });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "PROCEDURE_CASE", metadata: { count: cases.length } }) });
    res.json({ data: cases });
  } catch (error) {
    next(error);
  }
});

operationsRouter.post("/operations/ot/cases", requireAuth, requireRole(...otRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      patientId: z.string().min(1),
      surgeonId: z.string().min(1),
      roomId: z.string().min(1),
      procedureName: z.string().trim().min(1).max(200),
      startsAt: z.coerce.date(),
      endsAt: z.coerce.date(),
      operationalNotes: z.string().trim().max(2000).optional(),
    }).parse(req.body);
    if (input.endsAt <= input.startsAt || input.endsAt.getTime() - input.startsAt.getTime() > 24 * 60 * 60 * 1000) {
      return fail(res, 400, "PROCEDURE_TIME_INVALID", "The end time must be after the start time and within 24 hours.");
    }
    const access = await patientAccess(req.auth!.userId, req.auth!.role, input.patientId);
    if (access === "DOCTOR_PROFILE_REQUIRED") return fail(res, 403, access, "A doctor profile is required for this resource.");
    if (access !== "ALLOWED") return fail(res, 404, access, "The requested patient was not found.");
    const currentDoctor = req.auth!.role === Role.DOCTOR ? await doctorScope(req.auth!.userId) : null;
    if (currentDoctor && input.surgeonId !== currentDoctor.id) return fail(res, 403, "SURGEON_SCOPE_FORBIDDEN", "Doctors may schedule only cases assigned to their own profile.");
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(702607112, 2)::text AS acquired`;
      const [room, surgeon] = await Promise.all([
        tx.operatingRoom.findFirst({ where: { id: input.roomId, active: true }, select: { id: true } }),
        tx.doctor.findFirst({ where: { id: input.surgeonId, user: { active: true } }, select: { id: true } }),
      ]);
      if (!room || !surgeon) return { error: "ROOM_OR_SURGEON_NOT_FOUND" as const };
      const conflict = await tx.procedureCase.findFirst({
        where: {
          status: { notIn: [ProcedureCaseStatus.COMPLETED, ProcedureCaseStatus.CANCELLED] },
          startsAt: { lt: input.endsAt },
          endsAt: { gt: input.startsAt },
          OR: [{ roomId: input.roomId }, { surgeonId: input.surgeonId }],
        },
        select: { id: true },
      });
      if (conflict) return { error: "SCHEDULE_CONFLICT" as const };
      const created = await tx.procedureCase.create({ data: input, include: { ...includePatient, room: true } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE", entity: "PROCEDURE_CASE", entityId: created.id }) });
      return { procedureCase: created };
    });
    if ("error" in outcome) {
      return outcome.error === "ROOM_OR_SURGEON_NOT_FOUND"
        ? fail(res, 404, "OT_RESOURCE_NOT_FOUND", "The operating room or surgeon is unavailable.")
        : fail(res, 409, "OT_SCHEDULE_CONFLICT", "The operating room or surgeon already has an overlapping case.");
    }
    res.status(201).json({ data: outcome.procedureCase });
  } catch (error) {
    next(error);
  }
});

operationsRouter.patch("/operations/ot/cases/:id/status", requireAuth, requireRole(...otRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const { status } = z.object({ status: z.nativeEnum(ProcedureCaseStatus) }).parse(req.body);
    const id = paramsId(req);
    const doctor = req.auth!.role === Role.DOCTOR ? await doctorScope(req.auth!.userId) : null;
    if (req.auth!.role === Role.DOCTOR && !doctor) return fail(res, 403, "DOCTOR_PROFILE_REQUIRED", "A doctor profile is required for this resource.");
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ProcedureCase" WHERE id = ${id} FOR UPDATE`;
      const current = await tx.procedureCase.findFirst({ where: { id, ...(doctor ? { surgeonId: doctor.id } : {}) } });
      if (!current) return { error: "NOT_FOUND" as const };
      if (!canTransition(current.status, status, procedureTransitions)) return { error: "INVALID_TRANSITION" as const };
      const updated = await tx.procedureCase.update({ where: { id }, data: { status } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE_STATUS", entity: "PROCEDURE_CASE", entityId: id, metadata: { status } }) });
      return { procedureCase: updated };
    });
    if ("error" in outcome) {
      return outcome.error === "NOT_FOUND"
        ? fail(res, 404, "PROCEDURE_CASE_NOT_FOUND", "The procedure case was not found.")
        : fail(res, 409, "PROCEDURE_TRANSITION_INVALID", "That procedure status transition is not allowed.");
    }
    res.json({ data: outcome.procedureCase });
  } catch (error) {
    next(error);
  }
});

operationsRouter.get("/operations/blood-bank/units", requireAuth, requireRole(...bloodBankRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const units = await prisma.bloodProductUnit.findMany({ orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }], take: 300 });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "BLOOD_PRODUCT_UNIT", metadata: { count: units.length } }) });
    res.json({ data: units.map((unit) => ({ ...unit, expired: unit.expiresAt <= new Date() })) });
  } catch (error) {
    next(error);
  }
});

operationsRouter.post("/operations/blood-bank/units", requireAuth, requireRole(...bloodBankRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      unitNumber: z.string().trim().regex(/^[A-Za-z0-9-]{4,60}$/),
      bloodGroup: z.nativeEnum(BloodGroup),
      component: z.nativeEnum(BloodComponent),
      collectedAt: z.coerce.date(),
      expiresAt: z.coerce.date(),
    }).parse(req.body);
    if (input.expiresAt <= input.collectedAt) return fail(res, 400, "BLOOD_UNIT_DATES_INVALID", "Expiry must be after the collection date.");
    if (input.expiresAt <= new Date()) return fail(res, 400, "BLOOD_UNIT_EXPIRED", "An expired unit cannot be added as available stock.");
    const unit = await prisma.$transaction(async (tx) => {
      const created = await tx.bloodProductUnit.create({ data: input });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE", entity: "BLOOD_PRODUCT_UNIT", entityId: created.id, metadata: { component: input.component, bloodGroup: input.bloodGroup } }) });
      return created;
    });
    res.status(201).json({ data: unit });
  } catch (error) {
    next(error);
  }
});

operationsRouter.patch("/operations/blood-bank/units/:id/status", requireAuth, requireRole(...bloodBankRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const { status } = z.object({ status: z.nativeEnum(BloodUnitStatus) }).parse(req.body);
    const id = paramsId(req);
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "BloodProductUnit" WHERE id = ${id} FOR UPDATE`;
      const unit = await tx.bloodProductUnit.findUnique({ where: { id } });
      if (!unit) return { error: "NOT_FOUND" as const };
      if (!canTransition(unit.status, status, bloodTransitions)) return { error: "INVALID_TRANSITION" as const };
      if (unit.expiresAt <= new Date() && stockAvailableStatuses.has(status)) {
        return { error: "EXPIRED" as const };
      }
      const updated = await tx.bloodProductUnit.update({ where: { id }, data: { status } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE_STATUS", entity: "BLOOD_PRODUCT_UNIT", entityId: id, metadata: { status } }) });
      return { unit: updated };
    });
    if ("error" in outcome) {
      if (outcome.error === "NOT_FOUND") return fail(res, 404, "BLOOD_UNIT_NOT_FOUND", "The blood product unit was not found.");
      if (outcome.error === "EXPIRED") return fail(res, 409, "BLOOD_UNIT_EXPIRED", "Expired units cannot be made available, reserved, or issued.");
      return fail(res, 409, "BLOOD_UNIT_TRANSITION_INVALID", "That blood unit status transition is not allowed.");
    }
    res.json({ data: outcome.unit });
  } catch (error) {
    next(error);
  }
});

operationsRouter.get("/operations/ambulances", requireAuth, requireRole(...dispatchRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const ambulances = await prisma.ambulance.findMany({ orderBy: { callSign: "asc" } });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "AMBULANCE", metadata: { count: ambulances.length } }) });
    res.json({ data: ambulances });
  } catch (error) {
    next(error);
  }
});

operationsRouter.post("/operations/ambulances", requireAuth, requireRole(...administrators), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      callSign: z.string().trim().min(1).max(40),
      description: z.string().trim().max(200).optional(),
      baseLocation: z.string().trim().min(1).max(200),
    }).parse(req.body);
    const ambulance = await prisma.$transaction(async (tx) => {
      const created = await tx.ambulance.create({ data: input });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE", entity: "AMBULANCE", entityId: created.id }) });
      return created;
    });
    res.status(201).json({ data: ambulance });
  } catch (error) {
    next(error);
  }
});

operationsRouter.patch("/operations/ambulances/:id/status", requireAuth, requireRole(...administrators), async (req: AuthenticatedRequest, res, next) => {
  try {
    const { status } = z.object({ status: z.enum([AmbulanceStatus.AVAILABLE, AmbulanceStatus.OUT_OF_SERVICE]) }).parse(req.body);
    const id = paramsId(req);
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Ambulance" WHERE id = ${id} FOR UPDATE`;
      const activeDispatch = await tx.ambulanceDispatch.findFirst({
        where: { ambulanceId: id, status: { in: [AmbulanceDispatchStatus.DISPATCHED, AmbulanceDispatchStatus.EN_ROUTE, AmbulanceDispatchStatus.ARRIVED] } },
        select: { id: true },
      });
      if (activeDispatch) return { error: "DISPATCH_ACTIVE" as const };
      const updated = await tx.ambulance.update({ where: { id }, data: { status } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE_STATUS", entity: "AMBULANCE", entityId: id, metadata: { status } }) });
      return { ambulance: updated };
    });
    if ("error" in result) return fail(res, 409, "AMBULANCE_DISPATCH_ACTIVE", "An active dispatch prevents changing this ambulance's status.");
    res.json({ data: result.ambulance });
  } catch (error) {
    next(error);
  }
});

operationsRouter.get("/operations/ambulance/dispatches", requireAuth, requireRole(...dispatchRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const ownRequestsOnly = req.auth!.role === Role.DOCTOR || req.auth!.role === Role.NURSE;
    const dispatches = await prisma.ambulanceDispatch.findMany({
      where: ownRequestsOnly ? { requestedById: req.auth!.userId } : undefined,
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { ambulance: true, ...includePatient, requestedBy: { select: { name: true } } },
    });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "AMBULANCE_DISPATCH", metadata: { count: dispatches.length } }) });
    res.json({ data: dispatches });
  } catch (error) {
    next(error);
  }
});

operationsRouter.post("/operations/ambulance/dispatches", requireAuth, requireRole(...dispatchRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      patientId: z.string().optional(),
      pickupLocation: z.string().trim().min(1).max(200),
      destination: z.string().trim().min(1).max(200),
      notes: z.string().trim().max(1000).optional(),
    }).parse(req.body);
    if (input.patientId) {
      const access = await patientAccess(req.auth!.userId, req.auth!.role, input.patientId);
      if (access === "DOCTOR_PROFILE_REQUIRED") return fail(res, 403, access, "A doctor profile is required for this resource.");
      if (access !== "ALLOWED") return fail(res, 404, access, "The requested patient was not found.");
    }
    const dispatch = await prisma.$transaction(async (tx) => {
      const created = await tx.ambulanceDispatch.create({ data: { ...input, requestedById: req.auth!.userId }, include: { ambulance: true, ...includePatient } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE", entity: "AMBULANCE_DISPATCH", entityId: created.id }) });
      return created;
    });
    res.status(201).json({ data: dispatch });
  } catch (error) {
    next(error);
  }
});

operationsRouter.patch("/operations/ambulance/dispatches/:id/status", requireAuth, requireRole(...ambulanceDeskRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      status: z.nativeEnum(AmbulanceDispatchStatus),
      ambulanceId: z.string().optional(),
    }).parse(req.body);
    const id = paramsId(req);
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AmbulanceDispatch" WHERE id = ${id} FOR UPDATE`;
      const dispatch = await tx.ambulanceDispatch.findUnique({ where: { id } });
      if (!dispatch) return { error: "NOT_FOUND" as const };
      if (!canTransition(dispatch.status, input.status, dispatchTransitions)) return { error: "INVALID_TRANSITION" as const };
      let ambulanceId = dispatch.ambulanceId;
      if (input.status === AmbulanceDispatchStatus.DISPATCHED) {
        if (!input.ambulanceId) return { error: "AMBULANCE_REQUIRED" as const };
        const claimed = await tx.ambulance.updateMany({
          where: { id: input.ambulanceId, status: AmbulanceStatus.AVAILABLE },
          data: { status: AmbulanceStatus.DISPATCHED },
        });
        if (claimed.count !== 1) return { error: "AMBULANCE_UNAVAILABLE" as const };
        ambulanceId = input.ambulanceId;
      }
      const terminal = input.status === AmbulanceDispatchStatus.COMPLETED || input.status === AmbulanceDispatchStatus.CANCELLED;
      const updated = await tx.ambulanceDispatch.update({
        where: { id },
        data: {
          status: input.status,
          ambulanceId,
          dispatchedAt: input.status === AmbulanceDispatchStatus.DISPATCHED ? new Date() : undefined,
          arrivedAt: input.status === AmbulanceDispatchStatus.ARRIVED ? new Date() : undefined,
          completedAt: terminal ? new Date() : undefined,
        },
        include: { ambulance: true, ...includePatient },
      });
      if (terminal && ambulanceId) {
        await tx.ambulance.updateMany({ where: { id: ambulanceId, status: AmbulanceStatus.DISPATCHED }, data: { status: AmbulanceStatus.AVAILABLE } });
      }
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE_STATUS", entity: "AMBULANCE_DISPATCH", entityId: id, metadata: { status: input.status, ambulanceId } }) });
      return { dispatch: updated };
    });
    if ("error" in outcome) {
      if (outcome.error === "NOT_FOUND") return fail(res, 404, "DISPATCH_NOT_FOUND", "The ambulance dispatch was not found.");
      if (outcome.error === "AMBULANCE_REQUIRED") return fail(res, 400, outcome.error, "Select an available ambulance before dispatching.");
      if (outcome.error === "AMBULANCE_UNAVAILABLE") return fail(res, 409, outcome.error, "The selected ambulance is not available.");
      return fail(res, 409, "DISPATCH_TRANSITION_INVALID", "That dispatch status transition is not allowed.");
    }
    res.json({ data: outcome.dispatch });
  } catch (error) {
    next(error);
  }
});

operationsRouter.get("/operations/equipment", requireAuth, requireRole(...equipmentRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const equipment = await prisma.equipmentAsset.findMany({
      orderBy: { assetTag: "asc" },
      take: 300,
      include: { maintenance: { orderBy: { createdAt: "desc" }, take: 5 } },
    });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "EQUIPMENT_ASSET", metadata: { count: equipment.length } }) });
    res.json({ data: equipment });
  } catch (error) {
    next(error);
  }
});

operationsRouter.post("/operations/equipment", requireAuth, requireRole(...administrators), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      assetTag: z.string().trim().min(1).max(80),
      name: z.string().trim().min(1).max(160),
      category: z.string().trim().min(1).max(120),
      location: z.string().trim().min(1).max(200),
      nextMaintenanceAt: z.coerce.date().optional(),
      notes: z.string().trim().max(1000).optional(),
    }).parse(req.body);
    const equipment = await prisma.$transaction(async (tx) => {
      const created = await tx.equipmentAsset.create({ data: input });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE", entity: "EQUIPMENT_ASSET", entityId: created.id }) });
      return created;
    });
    res.status(201).json({ data: equipment });
  } catch (error) {
    next(error);
  }
});

operationsRouter.patch("/operations/equipment/:id/status", requireAuth, requireRole(...administrators), async (req: AuthenticatedRequest, res, next) => {
  try {
    const status = z.nativeEnum(EquipmentStatus).parse(req.body.status);
    const id = paramsId(req);
    const asset = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "EquipmentAsset" WHERE id = ${id} FOR UPDATE`;
      const activeMaintenance = await tx.equipmentMaintenance.count({
        where: { equipmentId: id, status: { in: [EquipmentMaintenanceStatus.OPEN, EquipmentMaintenanceStatus.IN_PROGRESS] } },
      });
      if (activeMaintenance && (status === EquipmentStatus.AVAILABLE || status === EquipmentStatus.IN_USE)) return null;
      const updated = await tx.equipmentAsset.update({ where: { id }, data: { status } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE_STATUS", entity: "EQUIPMENT_ASSET", entityId: id, metadata: { status } }) });
      return updated;
    });
    if (!asset) return fail(res, 409, "MAINTENANCE_ACTIVE", "Complete or cancel active maintenance before restoring this asset.");
    res.json({ data: asset });
  } catch (error) {
    next(error);
  }
});

operationsRouter.post("/operations/equipment/:id/maintenance", requireAuth, requireRole(...equipmentRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      description: z.string().trim().min(1).max(1000),
      dueAt: z.coerce.date().optional(),
    }).parse(req.body);
    const id = paramsId(req);
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "EquipmentAsset" WHERE id = ${id} FOR UPDATE`;
      const asset = await tx.equipmentAsset.findUnique({ where: { id } });
      if (!asset || asset.status === EquipmentStatus.RETIRED) return { error: "UNAVAILABLE" as const };
      const maintenance = await tx.equipmentMaintenance.create({ data: { equipmentId: id, ...input } });
      await tx.equipmentAsset.update({ where: { id }, data: { status: EquipmentStatus.MAINTENANCE } });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE", entity: "EQUIPMENT_MAINTENANCE", entityId: maintenance.id }) });
      return { maintenance };
    });
    if ("error" in outcome) return fail(res, 404, "EQUIPMENT_NOT_FOUND", "The equipment is unavailable.");
    res.status(201).json({ data: outcome.maintenance });
  } catch (error) {
    next(error);
  }
});

operationsRouter.patch("/operations/equipment/maintenance/:id/status", requireAuth, requireRole(...equipmentRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const status = z.nativeEnum(EquipmentMaintenanceStatus).parse(req.body.status);
    const id = paramsId(req);
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "EquipmentMaintenance" WHERE id = ${id} FOR UPDATE`;
      const current = await tx.equipmentMaintenance.findUnique({ where: { id } });
      if (!current) return { error: "NOT_FOUND" as const };
      await tx.$queryRaw`SELECT id FROM "EquipmentAsset" WHERE id = ${current.equipmentId} FOR UPDATE`;
      const equipment = await tx.equipmentAsset.findUniqueOrThrow({ where: { id: current.equipmentId } });
      if (!canTransition(current.status, status, maintenanceTransitions)) return { error: "INVALID_TRANSITION" as const };
      const updated = await tx.equipmentMaintenance.update({
        where: { id },
        data: { status, completedAt: status === EquipmentMaintenanceStatus.COMPLETED ? new Date() : undefined },
      });
      if (status === EquipmentMaintenanceStatus.COMPLETED) {
        const open = await tx.equipmentMaintenance.count({
          where: { equipmentId: current.equipmentId, id: { not: id }, status: { in: [EquipmentMaintenanceStatus.OPEN, EquipmentMaintenanceStatus.IN_PROGRESS] } },
        });
        await tx.equipmentAsset.update({
          where: { id: current.equipmentId },
          data: {
            status: equipment.status === EquipmentStatus.RETIRED
              ? EquipmentStatus.RETIRED
              : open === 0 ? EquipmentStatus.AVAILABLE : EquipmentStatus.MAINTENANCE,
            lastMaintenanceAt: new Date(),
          },
        });
      }
      if (status === EquipmentMaintenanceStatus.CANCELLED) {
        const open = await tx.equipmentMaintenance.count({
          where: { equipmentId: current.equipmentId, id: { not: id }, status: { in: [EquipmentMaintenanceStatus.OPEN, EquipmentMaintenanceStatus.IN_PROGRESS] } },
        });
        if (open === 0 && equipment.status === EquipmentStatus.MAINTENANCE) {
          await tx.equipmentAsset.update({ where: { id: current.equipmentId }, data: { status: EquipmentStatus.AVAILABLE } });
        }
      }
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE_STATUS", entity: "EQUIPMENT_MAINTENANCE", entityId: id, metadata: { status } }) });
      return { maintenance: updated };
    });
    if ("error" in outcome) {
      return outcome.error === "NOT_FOUND"
        ? fail(res, 404, "MAINTENANCE_NOT_FOUND", "The maintenance record was not found.")
        : fail(res, 409, "MAINTENANCE_TRANSITION_INVALID", "That maintenance status transition is not allowed.");
    }
    res.json({ data: outcome.maintenance });
  } catch (error) {
    next(error);
  }
});

operationsRouter.get("/operations/housekeeping/tasks", requireAuth, requireRole(...housekeepingRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const where = req.auth!.role === Role.HOUSEKEEPING
      ? { OR: [{ assignedToId: req.auth!.userId }, { assignedToId: null, status: HousekeepingTaskStatus.OPEN }] }
      : undefined;
    const tasks = await prisma.housekeepingTask.findMany({
      where,
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: 300,
      include: {
        ward: { select: { name: true } },
        bed: { select: { label: true } },
        assignedTo: { select: { id: true, name: true } },
      },
    });
    await prisma.auditLog.create({ data: auditLogData(req, { action: "READ", entity: "HOUSEKEEPING_TASK", metadata: { count: tasks.length } }) });
    res.json({ data: tasks });
  } catch (error) {
    next(error);
  }
});

operationsRouter.post("/operations/housekeeping/tasks", requireAuth, requireRole(...housekeepingRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({
      type: z.nativeEnum(HousekeepingTaskType),
      priority: z.nativeEnum(OperationsPriority).default(OperationsPriority.NORMAL),
      location: z.string().trim().min(1).max(200),
      details: z.string().trim().max(1000).optional(),
      wardId: z.string().optional(),
      bedId: z.string().optional(),
      assignedToId: z.string().optional(),
      dueAt: z.coerce.date().optional(),
    }).parse(req.body);
    if (input.bedId) {
      const bed = await prisma.bed.findUnique({ where: { id: input.bedId }, select: { wardId: true } });
      if (!bed || (input.wardId && input.wardId !== bed.wardId)) return fail(res, 404, "BED_NOT_FOUND", "The bed or selected ward was not found.");
    }
    const assigneeId = input.assignedToId ?? (req.auth!.role === Role.HOUSEKEEPING ? req.auth!.userId : undefined);
    if (req.auth!.role === Role.HOUSEKEEPING && assigneeId !== req.auth!.userId) return fail(res, 403, "HOUSEKEEPING_ASSIGNMENT_FORBIDDEN", "Housekeeping staff may assign tasks only to themselves.");
    if (assigneeId && !await prisma.user.findFirst({ where: { id: assigneeId, active: true, role: Role.HOUSEKEEPING }, select: { id: true } })) {
      return fail(res, 400, "HOUSEKEEPING_ASSIGNEE_INVALID", "The assignee must be an active housekeeping user.");
    }
    const task = await prisma.$transaction(async (tx) => {
      const created = await tx.housekeepingTask.create({
        data: { ...input, assignedToId: assigneeId, status: assigneeId ? HousekeepingTaskStatus.ASSIGNED : HousekeepingTaskStatus.OPEN },
        include: { ward: { select: { name: true } }, bed: { select: { label: true } }, assignedTo: { select: { id: true, name: true } } },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "CREATE", entity: "HOUSEKEEPING_TASK", entityId: created.id }) });
      return created;
    });
    res.status(201).json({ data: task });
  } catch (error) {
    next(error);
  }
});

operationsRouter.patch("/operations/housekeeping/tasks/:id/status", requireAuth, requireRole(...housekeepingRoles), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = z.object({ status: z.nativeEnum(HousekeepingTaskStatus), assignedToId: z.string().optional() }).parse(req.body);
    const id = paramsId(req);
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "HousekeepingTask" WHERE id = ${id} FOR UPDATE`;
      const task = await tx.housekeepingTask.findUnique({ where: { id } });
      if (!task) return { error: "NOT_FOUND" as const };
      if (req.auth!.role === Role.HOUSEKEEPING && task.assignedToId && task.assignedToId !== req.auth!.userId) return { error: "FORBIDDEN" as const };
      if (req.auth!.role === Role.HOUSEKEEPING && input.assignedToId && input.assignedToId !== req.auth!.userId) return { error: "FORBIDDEN" as const };
      if (!canTransition(task.status, input.status, housekeepingTransitions)) return { error: "INVALID_TRANSITION" as const };
      const assignedToId = input.assignedToId ?? (req.auth!.role === Role.HOUSEKEEPING && !task.assignedToId ? req.auth!.userId : task.assignedToId);
      if (assignedToId && !await tx.user.findFirst({ where: { id: assignedToId, active: true, role: Role.HOUSEKEEPING }, select: { id: true } })) {
        return { error: "ASSIGNEE_INVALID" as const };
      }
      if (
        (input.status === HousekeepingTaskStatus.ASSIGNED
          || input.status === HousekeepingTaskStatus.IN_PROGRESS
          || input.status === HousekeepingTaskStatus.COMPLETED)
        && !assignedToId
      ) {
        return { error: "ASSIGNEE_REQUIRED" as const };
      }
      const updated = await tx.housekeepingTask.update({
        where: { id },
        data: {
          status: input.status,
          assignedToId,
          completedAt: input.status === HousekeepingTaskStatus.COMPLETED ? new Date() : undefined,
        },
      });
      await tx.auditLog.create({ data: auditLogData(req, { action: "UPDATE_STATUS", entity: "HOUSEKEEPING_TASK", entityId: id, metadata: { status: input.status } }) });
      return { task: updated };
    });
    if ("error" in outcome) {
      if (outcome.error === "NOT_FOUND") return fail(res, 404, "HOUSEKEEPING_TASK_NOT_FOUND", "The housekeeping task was not found.");
      if (outcome.error === "FORBIDDEN") return fail(res, 403, outcome.error, "You cannot update a task assigned to another user.");
      if (outcome.error === "ASSIGNEE_INVALID" || outcome.error === "ASSIGNEE_REQUIRED") return fail(res, 400, outcome.error, "Assign the task to an active housekeeping user before starting it.");
      return fail(res, 409, "HOUSEKEEPING_TRANSITION_INVALID", "That housekeeping status transition is not allowed.");
    }
    res.json({ data: outcome.task });
  } catch (error) {
    next(error);
  }
});
