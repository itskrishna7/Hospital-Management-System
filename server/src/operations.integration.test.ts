import { once } from "node:events";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import { Role } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "./app.js";
import { prisma } from "./db.js";

const tag = `phase4-${crypto.randomUUID()}`;
const password = "Phase-Four-Integration-Password-2026!";
const emails = {
  admin: `${tag}-admin@example.test`,
  doctor: `${tag}-doctor@example.test`,
  radiologist: `${tag}-radiologist@example.test`,
  labTechnician: `${tag}-lab@example.test`,
  receptionist: `${tag}-reception@example.test`,
  housekeeper: `${tag}-housekeeping@example.test`,
};
let departmentId = "";
let patientId = "";
let doctorId = "";
let userIds: string[] = [];
let baseUrl = "";
let server: ReturnType<typeof app.listen>;

async function request(path: string, method = "GET", body?: unknown, cookie?: string) {
  const url = new URL(`${baseUrl}/api/v1${path}`);
  return new Promise<{ response: { status: number; headers: Headers }; payload: any }>((resolve, reject) => {
    const req = http.request(url, {
      method,
      localAddress: "127.0.0.4",
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
        resolve({ response: { status, headers }, payload: status === 204 ? undefined : JSON.parse(text) });
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

describe("Phase 4 operations PostgreSQL integration", () => {
  beforeAll(async () => {
    const department = await prisma.department.create({ data: { name: `Phase 4 ${tag}` } });
    departmentId = department.id;
    const passwordHash = await bcrypt.hash(password, 10);
    const roles = [
      ["admin", Role.ADMIN],
      ["doctor", Role.DOCTOR],
      ["radiologist", Role.RADIOLOGIST],
      ["labTechnician", Role.LAB_TECHNICIAN],
      ["receptionist", Role.RECEPTIONIST],
      ["housekeeper", Role.HOUSEKEEPING],
    ] as const;
    const users = await Promise.all(roles.map(([role, userRole]) =>
      prisma.user.create({ data: { email: emails[role], name: `Phase 4 ${role}`, role: userRole, passwordHash } }),
    ));
    userIds = users.map((user) => user.id);
    const doctor = users[1];
    doctorId = (await prisma.doctor.create({
      data: { userId: doctor.id, departmentId, specialty: "Phase 4 integration" },
    })).id;
    patientId = (await prisma.patient.create({
      data: {
        patientNumber: `P4-${crypto.randomUUID()}`,
        firstName: "Phase",
        lastName: "Four",
        dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
        phone: "0000000000",
        departmentId,
      },
    })).id;
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    if (server) {
      server.close();
      await once(server, "close");
    }
    if (patientId) {
      await prisma.refund.deleteMany({ where: { payment: { invoice: { patientId } } } });
      await prisma.payment.deleteMany({ where: { invoice: { patientId } } });
      await prisma.insuranceClaim.deleteMany({ where: { invoice: { patientId } } });
      await prisma.invoiceItem.deleteMany({ where: { invoice: { patientId } } });
      await prisma.invoice.deleteMany({ where: { patientId } });
      await prisma.insurancePolicy.deleteMany({ where: { patientId } });
      await prisma.imagingOrder.deleteMany({ where: { patientId } });
      await prisma.procedureCase.deleteMany({ where: { patientId } });
      await prisma.ambulanceDispatch.deleteMany({ where: { requestedById: { in: userIds } } });
    }
    await prisma.housekeepingTask.deleteMany({ where: { location: { startsWith: tag } } });
    await prisma.equipmentMaintenance.deleteMany({ where: { equipment: { assetTag: { startsWith: tag } } } });
    await prisma.equipmentAsset.deleteMany({ where: { assetTag: { startsWith: tag } } });
    await prisma.bloodProductUnit.deleteMany({ where: { unitNumber: { startsWith: tag } } });
    await prisma.ambulance.deleteMany({ where: { callSign: { startsWith: tag.slice(0, 30) } } });
    await prisma.operatingRoom.deleteMany({ where: { code: { startsWith: tag.slice(0, 30) } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { correlationId: tag }] } });
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.loginHistory.deleteMany({ where: { userId: { in: userIds }, email: { in: Object.values(emails) } } });
    if (doctorId) await prisma.doctor.deleteMany({ where: { id: doctorId } });
    if (patientId) await prisma.patient.deleteMany({ where: { id: patientId } });
    if (departmentId) await prisma.department.deleteMany({ where: { id: departmentId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }, 30_000);

  it("enforces role access and completes the manual operations workflows", async () => {
    const cookies = Object.fromEntries(await Promise.all(
      Object.entries(emails).map(async ([role, email]) => [role, await login(email)]),
    )) as Record<keyof typeof emails, string>;

    expect((await request("/operations/invoices", "GET", undefined, cookies.doctor)).response.status).toBe(403);

    const createdInvoice = await request("/operations/invoices", "POST", {
      patientId,
      tax: "0.00",
      items: [{ description: `${tag} consultation`, quantity: 1, unitPrice: "100.00" }],
    }, cookies.admin);
    expect(createdInvoice.response.status).toBe(201);
    const invoiceId = createdInvoice.payload.data.id as string;
    const payment = await request(`/operations/invoices/${invoiceId}/payments`, "POST", {
      amount: "40.00",
      method: "CASH",
      reference: `${tag}-payment`,
    }, cookies.admin);
    expect(payment.response.status).toBe(201);
    expect(payment.payload.data.balance).toBe("60.00");
    expect((await request(`/operations/invoices/${invoiceId}/payments`, "POST", {
      amount: "61.00",
      method: "CASH",
      reference: `${tag}-overpayment`,
    }, cookies.admin)).response.status).toBe(409);
    const refund = await request(`/operations/payments/${payment.payload.data.payment.id}/refunds`, "POST", {
      amount: "10.00",
      reference: `${tag}-refund`,
      reason: "Patient billing correction",
    }, cookies.admin);
    expect(refund.response.status).toBe(201);
    expect(refund.payload.data.balance).toBe("70.00");

    const policy = await request("/operations/insurance/policies", "POST", {
      patientId,
      payerName: `Payer ${tag}`,
      policyNumber: `${tag}-policy`,
      validFrom: new Date(Date.now() - 86_400_000).toISOString(),
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
    }, cookies.admin);
    expect(policy.response.status).toBe(201);
    const claim = await request("/operations/insurance/claims", "POST", {
      invoiceId,
      policyId: policy.payload.data.id,
      claimNumber: `${tag}-claim`,
      requestedAmount: "20.00",
    }, cookies.admin);
    expect(claim.response.status).toBe(201);
    const claimId = claim.payload.data.id as string;
    for (const status of ["SUBMITTED", "IN_REVIEW"]) {
      expect((await request(`/operations/insurance/claims/${claimId}/status`, "PATCH", { status }, cookies.admin)).response.status).toBe(200);
    }
    const approvedClaim = await request(`/operations/insurance/claims/${claimId}/status`, "PATCH", {
      status: "APPROVED",
      approvedAmount: "20.00",
    }, cookies.admin);
    expect(approvedClaim.payload.data.status).toBe("APPROVED");

    const imaging = await request("/operations/radiology/orders", "POST", {
      patientId,
      modality: "X_RAY",
      bodySite: "Chest",
      clinicalIndication: "Integration workflow test",
    }, cookies.doctor);
    expect(imaging.response.status).toBe(201);
    const imagingId = imaging.payload.data.id as string;
    expect((await request(`/operations/radiology/orders/${imagingId}/status`, "PATCH", { status: "IN_PROGRESS" }, cookies.radiologist)).response.status).toBe(200);
    const report = await request(`/operations/radiology/orders/${imagingId}/report`, "PATCH", { report: "Manual integration report." }, cookies.radiologist);
    expect(report.payload.data.status).toBe("COMPLETED");
    expect(report.payload.data.report).toBe("Manual integration report.");

    const room = await request("/operations/ot/rooms", "POST", {
      code: `${tag.slice(0, 30)}-room`,
      name: "Phase 4 test room",
    }, cookies.admin);
    expect(room.response.status).toBe(201);
    const startsAt = new Date(Date.now() + 3_600_000).toISOString();
    const endsAt = new Date(Date.now() + 7_200_000).toISOString();
    const procedure = {
      patientId,
      surgeonId: doctorId,
      roomId: room.payload.data.id,
      procedureName: "Integration workflow test",
      startsAt,
      endsAt,
    };
    expect((await request("/operations/ot/cases", "POST", procedure, cookies.admin)).response.status).toBe(201);
    const conflict = await request("/operations/ot/cases", "POST", procedure, cookies.admin);
    expect(conflict.response.status).toBe(409);
    expect(conflict.payload.error.code).toBe("OT_SCHEDULE_CONFLICT");

    const blood = await request("/operations/blood-bank/units", "POST", {
      unitNumber: `${tag}-blood`,
      bloodGroup: "O_POSITIVE",
      component: "RED_CELLS",
      collectedAt: new Date(Date.now() - 86_400_000).toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }, cookies.labTechnician);
    expect(blood.response.status).toBe(201);
    expect((await request(`/operations/blood-bank/units/${blood.payload.data.id}/status`, "PATCH", { status: "RESERVED" }, cookies.labTechnician)).response.status).toBe(200);
    const expiredBlood = await request("/operations/blood-bank/units", "POST", {
      unitNumber: `${tag}-expired-blood`,
      bloodGroup: "O_NEGATIVE",
      component: "PLASMA",
      collectedAt: new Date(Date.now() - 172_800_000).toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }, cookies.labTechnician);
    expect(expiredBlood.response.status).toBe(201);
    await prisma.bloodProductUnit.update({ where: { id: expiredBlood.payload.data.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    expect((await request(`/operations/blood-bank/units/${expiredBlood.payload.data.id}/status`, "PATCH", { status: "RESERVED" }, cookies.labTechnician)).response.status).toBe(409);

    const ambulance = await request("/operations/ambulances", "POST", {
      callSign: `${tag.slice(0, 30)}-ambulance`,
      baseLocation: "Test station",
    }, cookies.admin);
    expect(ambulance.response.status).toBe(201);
    const dispatch = await request("/operations/ambulance/dispatches", "POST", {
      pickupLocation: `${tag} pickup`,
      destination: "Test hospital",
    }, cookies.receptionist);
    expect(dispatch.response.status).toBe(201);
    const dispatchId = dispatch.payload.data.id as string;
    expect((await request(`/operations/ambulance/dispatches/${dispatchId}/status`, "PATCH", {
      status: "DISPATCHED",
      ambulanceId: ambulance.payload.data.id,
    }, cookies.receptionist)).response.status).toBe(200);
    expect((await request(`/operations/ambulances/${ambulance.payload.data.id}/status`, "PATCH", { status: "OUT_OF_SERVICE" }, cookies.admin)).response.status).toBe(409);
    for (const status of ["EN_ROUTE", "ARRIVED", "COMPLETED"]) {
      expect((await request(`/operations/ambulance/dispatches/${dispatchId}/status`, "PATCH", { status }, cookies.receptionist)).response.status).toBe(200);
    }
    expect((await prisma.ambulance.findUniqueOrThrow({ where: { id: ambulance.payload.data.id } })).status).toBe("AVAILABLE");

    const equipment = await request("/operations/equipment", "POST", {
      assetTag: `${tag}-asset`,
      name: "Phase 4 test equipment",
      category: "Diagnostic",
      location: "Test room",
    }, cookies.admin);
    expect(equipment.response.status).toBe(201);
    const maintenance = await request(`/operations/equipment/${equipment.payload.data.id}/maintenance`, "POST", {
      description: "Scheduled integration test maintenance",
    }, cookies.housekeeper);
    expect(maintenance.response.status).toBe(201);
    expect((await request(`/operations/equipment/${equipment.payload.data.id}/status`, "PATCH", { status: "AVAILABLE" }, cookies.admin)).response.status).toBe(409);
    for (const status of ["IN_PROGRESS", "COMPLETED"]) {
      expect((await request(`/operations/equipment/maintenance/${maintenance.payload.data.id}/status`, "PATCH", { status }, cookies.housekeeper)).response.status).toBe(200);
    }
    expect((await prisma.equipmentAsset.findUniqueOrThrow({ where: { id: equipment.payload.data.id } })).status).toBe("AVAILABLE");

    const retiredAsset = await request("/operations/equipment", "POST", {
      assetTag: `${tag}-retired-asset`,
      name: "Retired Phase 4 equipment",
      category: "Diagnostic",
      location: "Test room",
    }, cookies.admin);
    const retiredMaintenance = await request(`/operations/equipment/${retiredAsset.payload.data.id}/maintenance`, "POST", {
      description: "Maintenance before retirement",
    }, cookies.housekeeper);
    expect((await request(`/operations/equipment/${retiredAsset.payload.data.id}/status`, "PATCH", { status: "RETIRED" }, cookies.admin)).response.status).toBe(200);
    for (const status of ["IN_PROGRESS", "COMPLETED"]) {
      expect((await request(`/operations/equipment/maintenance/${retiredMaintenance.payload.data.id}/status`, "PATCH", { status }, cookies.housekeeper)).response.status).toBe(200);
    }
    expect((await prisma.equipmentAsset.findUniqueOrThrow({ where: { id: retiredAsset.payload.data.id } })).status).toBe("RETIRED");

    const task = await request("/operations/housekeeping/tasks", "POST", {
      type: "ROUTINE_CLEANING",
      priority: "HIGH",
      location: `${tag} ward`,
    }, cookies.housekeeper);
    expect(task.response.status).toBe(201);
    expect(task.payload.data.status).toBe("ASSIGNED");
    for (const status of ["IN_PROGRESS", "COMPLETED"]) {
      expect((await request(`/operations/housekeeping/tasks/${task.payload.data.id}/status`, "PATCH", { status }, cookies.housekeeper)).response.status).toBe(200);
    }
  }, 60_000);
});
