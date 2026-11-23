import { once } from "node:events";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import { AdmissionStatus, AppointmentStatus, BedStatus, IntelligenceAlertCategory, IntelligenceAlertStatus, LabStatus, QueueEntryStatus, Role } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "./app.js";
import { prisma } from "./db.js";

const tag = `intelligence-${crypto.randomUUID()}`;
const password = "Phase-Six-Integration-Password-2026!";
const emails = {
  admin: `${tag}-admin@example.test`,
  doctor: `${tag}-doctor@example.test`,
  nurse: `${tag}-nurse@example.test`,
  patient: `${tag}-patient@example.test`,
};
let departmentId = "";
let patientId = "";
let bedId = "";
let admissionId = "";
let historicalBedId = "";
let historicalAdmissionId = "";
let dischargeChecklistId = "";
let appointmentId = "";
let queueEntryId = "";
let labOrderId = "";
let invoiceId = "";
let medicineId = "";
let userIds: string[] = [];
let baseUrl = "";
let server: ReturnType<typeof app.listen>;

async function request(path: string, method = "GET", body?: unknown, cookie?: string) {
  const url = new URL(`${baseUrl}/api/v1${path}`);
  return new Promise<{ response: { status: number; headers: Headers }; payload: any }>((resolve, reject) => {
    const req = http.request(url, {
      method,
      localAddress: "127.0.0.5",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        origin: "http://localhost:5173",
        "x-correlation-id": tag,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
          else if (value !== undefined) headers.set(name, value);
        }
        const status = res.statusCode ?? 0;
        const text = Buffer.concat(chunks).toString();
        const payload = headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text;
        resolve({ response: { status, headers }, payload });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function login(email: string) {
  const result = await request("/auth/login", "POST", { email, password });
  expect(result.response.status).toBe(200);
  const cookie = result.response.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  return cookie!.split(";")[0];
}

describe("Phase 6 intelligence PostgreSQL integration", () => {
  beforeAll(async () => {
    const department = await prisma.department.create({ data: { name: `Intelligence ${tag}` } });
    departmentId = department.id;
    const passwordHash = await bcrypt.hash(password, 10);
    const roles = [
      ["admin", Role.ADMIN],
      ["doctor", Role.DOCTOR],
      ["nurse", Role.NURSE],
      ["patient", Role.PATIENT],
    ] as const;
    const users = await Promise.all(roles.map(([role, userRole]) =>
      prisma.user.create({ data: { email: emails[role], name: `Intelligence ${role}`, role: userRole, passwordHash } }),
    ));
    userIds = users.map((user) => user.id);
    const doctor = users.find((user) => user.role === Role.DOCTOR)!;
    await prisma.doctor.create({ data: { userId: doctor.id, departmentId, specialty: "Intelligence integration", onDuty: true } });
    patientId = (await prisma.patient.create({
      data: {
        patientNumber: `PI-${crypto.randomUUID()}`,
        firstName: "Integration",
        lastName: "Patient",
        dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
        phone: "0000000000",
        departmentId,
      },
    })).id;
    const ward = await prisma.ward.create({ data: { name: `Intelligence Ward ${tag}`, departmentId } });
    const bed = await prisma.bed.create({ data: { label: "I-1", wardId: ward.id, status: BedStatus.OCCUPIED } });
    bedId = bed.id;
    admissionId = (await prisma.admission.create({ data: { patientId, bedId } })).id;
    const historicalBed = await prisma.bed.create({ data: { label: "I-2", wardId: ward.id, status: BedStatus.AVAILABLE } });
    historicalBedId = historicalBed.id;
    const now = new Date();
    const historicalAdmission = await prisma.admission.create({
      data: {
        patientId,
        bedId: historicalBedId,
        status: AdmissionStatus.DISCHARGED,
        admittedAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
        dischargedAt: new Date(now.getTime() - 60 * 60 * 1000),
      },
    });
    historicalAdmissionId = historicalAdmission.id;
    dischargeChecklistId = (await prisma.dischargeChecklist.create({
      data: {
        admissionId: historicalAdmissionId,
        approvedById: doctor.id,
        approvedAt: new Date(now.getTime() - 60 * 60 * 1000),
        createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        finalizedAt: new Date(now.getTime() - 30 * 60 * 1000),
      },
    })).id;
    appointmentId = (await prisma.appointment.create({
      data: {
        patientId,
        doctorId: (await prisma.doctor.findUniqueOrThrow({ where: { userId: doctor.id } })).id,
        departmentId,
        startsAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        endsAt: new Date(now.getTime() - 60 * 60 * 1000),
        status: AppointmentStatus.COMPLETED,
      },
    })).id;
    const serviceDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    queueEntryId = (await prisma.queueEntry.create({
      data: {
        patientId,
        appointmentId,
        departmentId,
        serviceDate,
        sequence: 1,
        status: QueueEntryStatus.COMPLETED,
        checkedInAt: new Date(now.getTime() - 20 * 60 * 1000),
        calledAt: new Date(now.getTime() - 15 * 60 * 1000),
        startedAt: new Date(now.getTime() - 10 * 60 * 1000),
        completedAt: new Date(now.getTime() - 5 * 60 * 1000),
      },
    })).id;
    const labOrder = await prisma.labOrder.create({
      data: {
        patientId,
        testName: "Integration timing test",
        status: LabStatus.COMPLETED,
        createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        result: { create: { summary: "Integration result", createdAt: new Date(now.getTime() - 60 * 60 * 1000) } },
      },
    });
    labOrderId = labOrder.id;
    invoiceId = (await prisma.invoice.create({
      data: { patientId, subtotal: 100, tax: 0, total: 100, balance: 25, createdAt: new Date(now.getTime() - 60 * 60 * 1000) },
    })).id;
    const medicine = await prisma.medicine.create({
      data: { name: `Integration medicine ${tag}`, sku: `INT-${crypto.randomUUID()}`, quantity: 25, reorderLevel: 10, expiresAt: new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000) },
    });
    medicineId = medicine.id;
    await prisma.inventoryTransaction.create({
      data: { medicineId, quantity: -3, reason: "Phase 6 integration consumption", createdAt: new Date(now.getTime() - 30 * 60 * 1000) },
    });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    if (server) {
      server.close();
      await once(server, "close");
    }
    if (departmentId) await prisma.operationalAlert.deleteMany({ where: { departmentId } });
    if (admissionId) await prisma.admission.deleteMany({ where: { id: admissionId } });
    if (dischargeChecklistId) await prisma.dischargeChecklist.deleteMany({ where: { id: dischargeChecklistId } });
    if (historicalAdmissionId) await prisma.admission.deleteMany({ where: { id: historicalAdmissionId } });
    if (queueEntryId) await prisma.queueEntry.deleteMany({ where: { id: queueEntryId } });
    if (labOrderId) await prisma.labResult.deleteMany({ where: { labOrderId } });
    if (appointmentId) await prisma.appointment.deleteMany({ where: { id: appointmentId } });
    if (labOrderId) await prisma.labOrder.deleteMany({ where: { id: labOrderId } });
    if (invoiceId) await prisma.invoice.deleteMany({ where: { id: invoiceId } });
    if (medicineId) await prisma.inventoryTransaction.deleteMany({ where: { medicineId } });
    if (medicineId) await prisma.medicine.deleteMany({ where: { id: medicineId } });
    if (bedId) await prisma.bed.deleteMany({ where: { id: bedId } });
    if (historicalBedId) await prisma.bed.deleteMany({ where: { id: historicalBedId } });
    await prisma.ward.deleteMany({ where: { name: `Intelligence Ward ${tag}` } });
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.loginHistory.deleteMany({ where: { userId: { in: userIds }, email: { in: Object.values(emails) } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    if (patientId) await prisma.patient.deleteMany({ where: { id: patientId } });
    await prisma.doctor.deleteMany({ where: { userId: { in: userIds } } });
    if (departmentId) await prisma.department.deleteMany({ where: { id: departmentId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }, 30_000);

  it("generates deduplicated alerts and enforces acknowledgement, resolution, and scope", async () => {
    const adminCookie = await login(emails.admin);
    const doctorCookie = await login(emails.doctor);
    const nurseCookie = await login(emails.nurse);
    const patientCookie = await login(emails.patient);

    expect((await request("/intelligence/alerts", "GET", undefined, patientCookie)).response.status).toBe(403);
    expect((await request(`/intelligence/alerts?departmentId=${departmentId}`, "GET", undefined, doctorCookie)).response.status).toBe(200);
    expect((await request("/intelligence/alerts?category=BILLING", "GET", undefined, doctorCookie)).response.status).toBe(403);

    expect((await request("/intelligence/alert-rules", "GET", undefined, adminCookie)).response.status).toBe(200);
    const criticalRule = await prisma.operationalAlertRule.findUniqueOrThrow({ where: { key: "BED_OCCUPANCY_CRITICAL" } });
    const thresholdUpdate = await request("/intelligence/alert-rules/BED_OCCUPANCY_CRITICAL", "PATCH", {
      enabled: true,
      threshold: 49,
    }, adminCookie);
    expect(thresholdUpdate.response.status).toBe(200);
    expect(thresholdUpdate.payload.data.threshold).toBe(49);
    expect((await prisma.operationalAlertRule.findUniqueOrThrow({ where: { key: "BED_OCCUPANCY_CRITICAL" } })).updatedById).toBe(userIds[0]);
    expect(await prisma.auditLog.count({ where: { userId: userIds[0], action: "UPDATE_ALERT_RULE", entityId: "BED_OCCUPANCY_CRITICAL" } })).toBe(1);
    expect((await request("/intelligence/alerts/refresh", "POST", {}, adminCookie)).response.status).toBe(200);
    expect((await request("/intelligence/alerts/refresh", "POST", {}, adminCookie)).response.status).toBe(200);
    const critical = await prisma.operationalAlert.findMany({
      where: { departmentId, ruleKey: "BED_OCCUPANCY_CRITICAL", status: IntelligenceAlertStatus.OPEN },
    });
    expect(critical).toHaveLength(1);
    await request("/intelligence/alert-rules/BED_OCCUPANCY_CRITICAL", "PATCH", {
      enabled: criticalRule.enabled,
      threshold: criticalRule.threshold,
    }, adminCookie);
    expect(await prisma.operationalAlert.count({
      where: { departmentId, ruleKey: "BED_OCCUPANCY_CRITICAL", status: IntelligenceAlertStatus.OPEN },
    })).toBe(1);

    const alertId = critical[0].id;
    expect((await request(`/intelligence/alerts/${alertId}/acknowledge`, "PATCH", {}, nurseCookie)).response.status).toBe(200);
    expect((await prisma.operationalAlert.findUniqueOrThrow({ where: { id: alertId } })).status).toBe(IntelligenceAlertStatus.ACKNOWLEDGED);
    expect(await prisma.auditLog.count({ where: { userId: userIds[2], action: "ACKNOWLEDGE_ALERT", entityId: alertId } })).toBe(1);
    expect((await request(`/intelligence/alerts/${alertId}/resolve`, "PATCH", {}, adminCookie)).response.status).toBe(200);
    expect((await prisma.operationalAlert.findUniqueOrThrow({ where: { id: alertId } })).status).toBe(IntelligenceAlertStatus.RESOLVED);
    expect(await prisma.operationalAlert.count({ where: { id: alertId, resolvedById: userIds[0] } })).toBe(1);

    const unauthorizedCategory = await request(`/intelligence/alerts?category=${IntelligenceAlertCategory.BILLING}`, "GET", undefined, doctorCookie);
    expect(unauthorizedCategory.response.status).toBe(403);
    expect((await request("/intelligence/analytics?startDate=2020-01-01&endDate=2021-01-02", "GET", undefined, adminCookie)).response.status).toBe(400);
    expect((await request("/intelligence/alerts?page=0", "GET", undefined, adminCookie)).response.status).toBe(400);
  }, 30_000);

  it("returns privacy-preserving briefings, unavailable empty metrics, and isolated hypothetical simulations", async () => {
    const adminCookie = await login(emails.admin);
    const doctorCookie = await login(emails.doctor);
    const patientCookie = await login(emails.patient);
    const today = new Date().toISOString().slice(0, 10);
    const briefing = await request(`/intelligence/briefing?date=${today}&departmentId=${departmentId}`, "GET", undefined, adminCookie);
    expect(briefing.response.status).toBe(200);
    expect(briefing.payload.data.currentAdmissions).toBe(1);
    expect(briefing.payload.data.beds).toMatchObject({ total: 2, occupied: 1, available: 1 });
    expect(JSON.stringify(briefing.payload.data)).not.toContain("Integration Patient");

    const csv = await request(`/intelligence/briefing?date=${today}&departmentId=${departmentId}&format=csv`, "GET", undefined, adminCookie);
    expect(csv.response.status).toBe(200);
    expect(csv.response.headers.get("content-type")).toContain("text/csv");
    expect(csv.payload).toContain("Pending laboratory orders");
    expect(csv.payload).not.toContain("Integration Patient");

    const analytics = await request(`/intelligence/analytics?startDate=${today}&endDate=${today}&departmentId=${departmentId}`, "GET", undefined, adminCookie);
    expect(analytics.response.status).toBe(200);
    expect(analytics.payload.data.metrics.averageWaitingTime.value).toBeCloseTo(5, 2);
    expect(analytics.payload.data.metrics.appointmentCompletionRate.value).toBe(100);
    expect(analytics.payload.data.metrics.averageLengthOfStay.value).toBeCloseTo(47, 2);
    expect(analytics.payload.data.metrics.averageDischargeProcessingTime.value).toBeCloseTo(1.5, 2);
    expect(analytics.payload.data.metrics.averageLaboratoryTurnaround.value).toBeCloseTo(1, 2);
    expect(analytics.payload.data.metrics.billingCollectionRate.value).toBeCloseTo(75, 2);
    expect(analytics.payload.data.inventoryConsumption.dailyUnitsConsumed).toHaveLength(1);
    const emptyAnalytics = await request("/intelligence/analytics?startDate=2000-01-01&endDate=2000-01-02", "GET", undefined, adminCookie);
    expect(emptyAnalytics.response.status).toBe(200);
    expect(emptyAnalytics.payload.data.metrics.averageWaitingTime).toMatchObject({ status: "unavailable", value: null });
    expect(emptyAnalytics.payload.data.metrics.billingCollectionRate).toMatchObject({ status: "unavailable", value: null });

    const forecasts = await request("/intelligence/forecasts?lookbackDays=7&horizonDays=3", "GET", undefined, adminCookie);
    expect(forecasts.response.status).toBe(200);
    expect(forecasts.payload.data.estimatesOnly).toBe(true);
    expect(forecasts.payload.data.bedOccupancy.status).toBe("insufficient_history");
    expect(forecasts.payload.data.bedOccupancy.projection).toEqual([]);

    expect((await request(`/intelligence/analytics?departmentId=${departmentId}`, "GET", undefined, doctorCookie)).response.status).toBe(200);
    expect((await request("/intelligence/analytics?departmentId=other-department", "GET", undefined, doctorCookie)).response.status).toBe(403);
    expect((await request("/intelligence/forecasts", "GET", undefined, patientCookie)).response.status).toBe(403);

    const before = await prisma.$transaction([
      prisma.admission.count({ where: { patientId, status: AdmissionStatus.ACTIVE } }),
      prisma.bed.findUniqueOrThrow({ where: { id: bedId }, select: { status: true } }),
    ]);
    const simulation = await request("/intelligence/simulations", "POST", {
      kind: "bed_capacity",
      admissionsPerDay: 4,
      dischargesPerDay: 0,
      horizonDays: 2,
      departmentId,
    }, adminCookie);
    expect(simulation.response.status).toBe(200);
    expect(simulation.payload.data.hypothetical).toBe(true);
    expect(simulation.payload.data.projection).toHaveLength(2);
    expect((await request("/intelligence/simulations", "POST", { kind: "bed_capacity", horizonDays: 90 }, adminCookie)).response.status).toBe(400);
    const after = await prisma.$transaction([
      prisma.admission.count({ where: { patientId, status: AdmissionStatus.ACTIVE } }),
      prisma.bed.findUniqueOrThrow({ where: { id: bedId }, select: { status: true } }),
    ]);
    expect(after).toEqual(before);
  }, 30_000);
});
