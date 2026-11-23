import { once } from "node:events";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import { AdmissionStatus, BedStatus, OutboxEventStatus, Role } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "./app.js";
import { prisma } from "./db.js";

const tag = `phase5-${crypto.randomUUID()}`;
const password = "Phase-Five-Integration-Password-2026!";
const emails = {
  admin: `${tag}-admin@example.test`,
  doctor: `${tag}-doctor@example.test`,
  nurse: `${tag}-nurse@example.test`,
  patient: `${tag}-patient@example.test`,
};
let departmentId = "";
let patientId = "";
let admissionId = "";
let bedId = "";
let userIds: string[] = [];
let baseUrl = "";
let server: ReturnType<typeof app.listen>;

async function request(path: string, method = "GET", body?: unknown, cookie?: string, authorization?: string) {
  const url = new URL(`${baseUrl}/api/v1${path}`);
  return new Promise<{ response: { status: number; headers: Headers }; payload: any }>((resolve, reject) => {
    const req = http.request(url, {
      method,
      localAddress: "127.0.0.5",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...(authorization ? { authorization } : {}),
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

describe("Phase 5 live operations and discharge PostgreSQL integration", () => {
  beforeAll(async () => {
    const department = await prisma.department.create({ data: { name: `Phase 5 ${tag}` } });
    departmentId = department.id;
    const passwordHash = await bcrypt.hash(password, 10);
    const roles = [
      ["admin", Role.ADMIN],
      ["doctor", Role.DOCTOR],
      ["nurse", Role.NURSE],
      ["patient", Role.PATIENT],
    ] as const;
    const users = await Promise.all(roles.map(([role, userRole]) =>
      prisma.user.create({ data: { email: emails[role], name: `Phase 5 ${role}`, role: userRole, passwordHash, emailVerifiedAt: userRole === Role.PATIENT ? new Date() : null } }),
    ));
    userIds = users.map((user) => user.id);
    const doctor = users.find((user) => user.role === Role.DOCTOR)!;
    await prisma.doctor.create({ data: { userId: doctor.id, departmentId, specialty: "Phase 5 integration" } });
    patientId = (await prisma.patient.create({
      data: {
        patientNumber: `P5-${crypto.randomUUID()}`,
        firstName: "Phase",
        lastName: "Five",
        dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
        phone: "0000000000",
        departmentId,
        portalUserId: users.find((user) => user.role === Role.PATIENT)!.id,
      },
    })).id;
    await prisma.portalNotificationPreference.create({
      data: { userId: users.find((user) => user.role === Role.PATIENT)!.id, emailEnabled: false },
    });
    const ward = await prisma.ward.create({ data: { name: `Phase 5 Ward ${tag}`, departmentId } });
    const bed = await prisma.bed.create({ data: { label: "P5-1", wardId: ward.id, status: BedStatus.OCCUPIED } });
    bedId = bed.id;
    admissionId = (await prisma.admission.create({ data: { patientId, bedId } })).id;
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    if (server) {
      server.close();
      await once(server, "close");
    }
    await prisma.outboxEvent.deleteMany({
      where: {
        OR: [
          { idempotencyKey: { startsWith: `${tag}:` } },
          ...(admissionId ? [{ idempotencyKey: `discharge-finalized:${admissionId}` }] : []),
        ],
      },
    });
    await prisma.staffNotification.deleteMany({ where: { recipientUserId: { in: userIds } } });
    await prisma.portalNotification.deleteMany({ where: { userId: { in: userIds } } });
    if (admissionId) await prisma.admission.deleteMany({ where: { id: admissionId } });
    if (bedId) await prisma.bed.deleteMany({ where: { id: bedId } });
    await prisma.ward.deleteMany({ where: { name: `Phase 5 Ward ${tag}` } });
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.loginHistory.deleteMany({ where: { userId: { in: userIds }, email: { in: Object.values(emails) } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.patient.deleteMany({ where: { id: patientId } });
    await prisma.doctor.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.department.deleteMany({ where: { id: departmentId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }, 30_000);

  it("uses live aggregate data and finalizes only after doctor approval and checklist completion", async () => {
    const cookies = Object.fromEntries(await Promise.all(
      Object.entries(emails).map(async ([role, email]) => [role, await login(email)]),
    )) as Record<keyof typeof emails, string>;

    const twin = await request("/operations/twin", "GET", undefined, cookies.nurse);
    expect(twin.response.status).toBe(200);
    expect(twin.payload.data.activeAdmissions).toBeGreaterThanOrEqual(1);
    expect(twin.payload.data.occupiedBeds).toBeGreaterThanOrEqual(1);
    expect(twin.payload.data).not.toHaveProperty("patients");
    expect((await request("/operations/twin", "GET", undefined, cookies.patient)).response.status).toBe(403);

    const directDischarge = await request(`/admissions/${admissionId}/status`, "PATCH", { status: "DISCHARGED" }, cookies.nurse);
    expect(directDischarge.response.status).toBe(409);
    expect((await prisma.admission.findUniqueOrThrow({ where: { id: admissionId } })).status).toBe(AdmissionStatus.ACTIVE);

    const item = await request(`/admissions/${admissionId}/discharge-checklist/items`, "POST", {
      label: `${tag} operational task`,
    }, cookies.nurse);
    expect(item.response.status).toBe(201);
    expect((await request(`/admissions/${admissionId}/discharge-checklist/approve`, "POST", {}, cookies.nurse)).response.status).toBe(403);

    const approval = await request(`/admissions/${admissionId}/discharge-checklist/approve`, "POST", {}, cookies.doctor);
    expect(approval.response.status).toBe(200);
    expect(approval.payload.data.approvedAt).toBeTruthy();
    expect(approval.payload.data.finalizedAt).toBeNull();
    expect((await prisma.bed.findUniqueOrThrow({ where: { id: bedId } })).status).toBe(BedStatus.OCCUPIED);

    const completion = await request(`/admissions/${admissionId}/discharge-checklist/items/${item.payload.data.id}`, "PATCH", {
      completed: true,
    }, cookies.nurse);
    expect(completion.response.status).toBe(200);
    expect(completion.payload.data.finalizedAt).toBeTruthy();
    expect((await prisma.admission.findUniqueOrThrow({ where: { id: admissionId } })).status).toBe(AdmissionStatus.DISCHARGED);
    expect((await prisma.bed.findUniqueOrThrow({ where: { id: bedId } })).status).toBe(BedStatus.AVAILABLE);

    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { idempotencyKey: `discharge-finalized:${admissionId}` } });
    expect(event.status).toBe(OutboxEventStatus.COMPLETED);
    expect(await prisma.staffNotification.count({ where: { eventId: event.id } })).toBeGreaterThan(0);
    expect(await prisma.portalNotification.count({ where: { sourceEventId: event.id } })).toBe(1);
    const alerts = await request("/notifications/staff", "GET", undefined, cookies.nurse);
    expect(alerts.payload.data.items.some((alert: { title: string }) => alert.title === "Discharge finalized")).toBe(true);
    const outbox = await request("/operations/outbox", "GET", undefined, cookies.admin);
    expect(outbox.response.status).toBe(200);
    expect(outbox.payload.data.counts.COMPLETED).toBeGreaterThan(0);
    expect((await request("/operations/outbox", "GET", undefined, cookies.doctor)).response.status).toBe(403);

    expect((await request("/internal/cron/process-outbox")).response.status).toBe(401);
    const cron = await request(
      "/internal/cron/process-outbox",
      "GET",
      undefined,
      undefined,
      `Bearer ${process.env.CRON_SECRET}`,
    );
    expect(cron.response.status).toBe(200);
  }, 30_000);
});
