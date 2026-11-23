import { once } from "node:events";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import { Role } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const deliveries = vi.hoisted(() => ({ email: [] as Array<{ to: string; subject: string; text: string }>, failEmail: false }));
vi.mock("./notification-delivery.js", () => ({
  DeliveryUnavailableError: class DeliveryUnavailableError extends Error {},
  sendPortalEmail: vi.fn(async (to: string, subject: string, text: string) => { if (deliveries.failEmail) throw new Error("provider unavailable"); deliveries.email.push({ to, subject, text }); }),
}));

import app from "./app.js";
import { prisma } from "./db.js";

const tag = `phase3${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
const runId = `phase3-${tag}`;
const patientEmail = `${tag}-patient@example.test`;
const familyEmail = `${tag}-family@example.test`;
const staffEmail = `${tag}-reception@example.test`;
const password = "Phase-Three-Integration-Password-2026!";
const phone = "+15555551234";
let departmentId = "";
let patientId = "";
let unrelatedPatientId = "";
let baseUrl = "";
let patientUserId = "";
let familyUserId = "";
let receptionistId = "";
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
        "x-correlation-id": runId,
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

function responseCookie(response: { headers: Headers }) {
  const value = response.headers.get("set-cookie");
  expect(value).toBeTruthy();
  return value!.split(";")[0];
}

async function login(email: string) {
  const result = await request("/auth/login", "POST", { email, password });
  expect(result.response.status).toBe(200);
  return responseCookie(result.response);
}

function codeFromMessage(message: string) {
  const code = message.match(/\b\d{6}\b/)?.[0];
  expect(code).toBeTruthy();
  return code!;
}

describe("Phase 3 patient-portal PostgreSQL integration", () => {
  beforeAll(async () => {
    deliveries.email.length = 0;
    deliveries.failEmail = false;
    const department = await prisma.department.create({ data: { name: `Phase 3 ${tag}` } });
    departmentId = department.id;
    const [doctorUser, receptionist] = await Promise.all([
      prisma.user.create({ data: { email: `${tag}-doctor@example.test`, name: "Phase 3 Doctor", role: Role.DOCTOR, passwordHash: await bcrypt.hash(password, 12) } }),
      prisma.user.create({ data: { email: staffEmail, name: "Phase 3 Reception", role: Role.RECEPTIONIST, passwordHash: await bcrypt.hash(password, 12) } }),
    ]);
    receptionistId = receptionist.id;
    await prisma.doctor.create({ data: { userId: doctorUser.id, departmentId, specialty: "Portal integration", onDuty: true } });
    const [patient, unrelatedPatient] = await Promise.all([
      prisma.patient.create({
        data: {
          patientNumber: `TST-${tag}`,
          firstName: "Portal",
          lastName: "Patient",
          dateOfBirth: new Date("1991-04-15T00:00:00.000Z"),
          phone,
          departmentId,
        },
      }),
      prisma.patient.create({
        data: {
          patientNumber: `TST-OTHER-${tag}`,
          firstName: "Unrelated",
          lastName: "Patient",
          dateOfBirth: new Date("1989-08-20T00:00:00.000Z"),
          phone: "+15555559876",
          departmentId,
        },
      }),
    ]);
    patientId = patient.id;
    unrelatedPatientId = unrelatedPatient.id;
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    if (server) {
      server.close();
      await once(server, "close");
    }
    const users = await prisma.user.findMany({ where: { email: { in: [patientEmail, familyEmail, staffEmail, `${tag}-doctor@example.test`] } }, select: { id: true } });
    const userIds = users.map((user) => user.id);
    if (patientId) {
      const appointments = await prisma.appointment.findMany({ where: { patientId }, select: { id: true } });
      const appointmentIds = appointments.map((item) => item.id);
      await prisma.appointmentCheckInToken.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
      await prisma.queueEntry.deleteMany({ where: { patientId } });
      await prisma.queueCounter.deleteMany({ where: { departmentId } });
      await prisma.appointment.deleteMany({ where: { patientId } });
      await prisma.portalVerificationChallenge.deleteMany({ where: { patientId } });
      await prisma.patientAccessGrant.deleteMany({ where: { patientId } });
      await prisma.familyAccessInvitation.deleteMany({ where: { patientId } });
    }
    await prisma.portalVerificationChallenge.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.portalNotificationPreference.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.portalNotification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { correlationId: runId }] } });
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.loginHistory.deleteMany({ where: { email: { in: [patientEmail, familyEmail, staffEmail, `${tag}-doctor@example.test`] } } });
    await prisma.doctor.deleteMany({ where: { departmentId } });
    if (patientId) await prisma.patient.deleteMany({ where: { id: patientId } });
    if (unrelatedPatientId) await prisma.patient.deleteMany({ where: { id: unrelatedPatientId } });
    if (departmentId) await prisma.department.deleteMany({ where: { id: departmentId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }, 30_000);

  it("verifies patient registration, scopes family access, books appointments, and consumes QR check-in once", async () => {
    const invalidRegistration = await request("/portal/register", "POST", {
      patientNumber: `INVALID-${tag}`,
      dateOfBirth: "1991-04-15",
      email: patientEmail,
      password,
    });
    expect(invalidRegistration.response.status).toBe(202);
    expect(invalidRegistration.payload.data.message).toContain("If the supplied details match");
    expect(deliveries.email).toHaveLength(0);

    const registration = await request("/portal/register", "POST", {
      patientNumber: `TST-${tag}`,
      dateOfBirth: "1991-04-15",
      email: patientEmail,
      password,
    });
    expect(registration.response.status).toBe(202);
    const invalidVerify = await request("/portal/register/verify", "POST", { challengeId: invalidRegistration.payload.data.challengeId, code: "111111" });
    expect(invalidVerify.response.status).toBe(400);
    const created = await request("/portal/register/verify", "POST", { challengeId: registration.payload.data.challengeId, code: codeFromMessage(deliveries.email[0].text) });
    expect(created.response.status).toBe(201);
    expect(created.payload.data.emailVerificationRequired).toBe(false);
    patientUserId = created.payload.data.user.id;
    const patientCookie = await login(patientEmail);

    const emailCodeRequest = await request("/portal/email/verification", "POST", {}, patientCookie);
    expect(emailCodeRequest.response.status).toBe(200);
    expect(emailCodeRequest.payload.data.verified).toBe(true);
    expect(deliveries.email).toHaveLength(1);
    const preferences = await request("/portal/notification-preferences", "PATCH", { inAppEnabled: true, emailEnabled: true, smsEnabled: true }, patientCookie);
    expect(preferences.response.status).toBe(200);
    expect(preferences.payload.data.smsEnabled).toBe(false);

    const invitation = await request("/portal/family/invitations", "POST", {
      email: familyEmail,
      scopes: ["APPOINTMENTS", "JOURNEY"],
      expiresInDays: 7,
    }, patientCookie);
    expect(invitation.response.status).toBe(201);
    const inviteToken = deliveries.email[1].text.match(/familyInvite=([A-Za-z0-9_-]+)/)?.[1];
    expect(inviteToken).toBeTruthy();
    expect(deliveries.email[1].text).not.toContain("Portal Patient");
    expect(deliveries.email[1].text).not.toContain(`TST-${tag}`);
    const preview = await request(`/portal/family/invitations/preview?token=${encodeURIComponent(inviteToken!)}`);
    expect(preview.response.status).toBe(200);
    expect(preview.payload.data.scopes).toEqual(["APPOINTMENTS", "JOURNEY"]);
    expect(JSON.stringify(preview.payload.data)).not.toContain(patientId);
    const familyRegistration = await request("/portal/family/invitations/register", "POST", { token: inviteToken, name: "Portal Family", password });
    expect(familyRegistration.response.status).toBe(201);
    familyUserId = familyRegistration.payload.data.user.id;
    const familyCookie = await login(familyEmail);
    expect((await request("/portal/patients", "GET", undefined, familyCookie)).payload.data).toHaveLength(1);
    expect((await request(`/portal/billing?patientId=${patientId}`, "GET", undefined, familyCookie)).response.status).toBe(404);
    expect((await request(`/portal/lab-results?patientId=${patientId}`, "GET", undefined, familyCookie)).response.status).toBe(404);
    expect((await request(`/portal/billing?patientId=${unrelatedPatientId}`, "GET", undefined, patientCookie)).response.status).toBe(404);
    expect((await request(`/portal/billing?patientId=${unrelatedPatientId}`, "GET", undefined, familyCookie)).response.status).toBe(404);

    const doctors = await request(`/portal/doctors?patientId=${patientId}`, "GET", undefined, patientCookie);
    expect(doctors.response.status).toBe(200);
    const doctor = doctors.payload.data.find((item: { department: { id: string } }) => item.department.id === departmentId);
    expect(doctor).toBeTruthy();
    await prisma.doctor.update({ where: { id: doctor.id }, data: { onDuty: false } });
    const offDutyDoctors = await request(`/portal/doctors?patientId=${patientId}`, "GET", undefined, patientCookie);
    expect(offDutyDoctors.payload.data.some((item: { id: string }) => item.id === doctor.id)).toBe(false);
    const offDutyBooking = await request("/portal/appointments", "POST", {
      patientId,
      doctorId: doctor.id,
      startsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      endsAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    }, patientCookie);
    expect(offDutyBooking.response.status).toBe(404);
    await prisma.doctor.update({ where: { id: doctor.id }, data: { onDuty: true } });
    expect((await request(`/portal/appointments?patientId=${patientId}`, "GET", undefined, familyCookie)).response.status).toBe(200);
    const startsAt = new Date(Date.now() + 10 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
    const appointment = await request("/portal/appointments", "POST", {
      patientId,
      doctorId: doctor.id,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    }, patientCookie);
    expect(appointment.response.status).toBe(201);
    const conflict = await request("/portal/appointments", "POST", {
      patientId,
      doctorId: doctor.id,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    }, familyCookie);
    expect(conflict.response.status).toBe(409);

    const concurrentStartsAt = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);
    const concurrentEndsAt = new Date(concurrentStartsAt.getTime() + 60 * 60 * 1000);
    const concurrentBookings = await Promise.all([patientCookie, familyCookie].map((cookie) => request("/portal/appointments", "POST", {
      patientId,
      doctorId: doctor.id,
      startsAt: concurrentStartsAt.toISOString(),
      endsAt: concurrentEndsAt.toISOString(),
    }, cookie)));
    expect(concurrentBookings.filter((result) => result.response.status === 201)).toHaveLength(1);
    expect(concurrentBookings.every((result) => [201, 409].includes(result.response.status))).toBe(true);

    const expiredQr = await request(`/portal/appointments/${appointment.payload.data.appointment.id}/check-in-token`, "POST", { patientId }, patientCookie);
    expect(expiredQr.response.status).toBe(201);
    expect(expiredQr.payload.data.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(expiredQr.payload.data.token).not.toContain(patientId);
    const storedToken = await prisma.appointmentCheckInToken.findFirst({ where: { appointmentId: appointment.payload.data.appointment.id }, orderBy: { createdAt: "desc" } });
    expect(storedToken).toBeTruthy();
    expect(storedToken!.tokenHash).not.toBe(expiredQr.payload.data.token);
    expect(storedToken!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(storedToken!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 2 * 60 * 1000);
    await prisma.appointmentCheckInToken.update({ where: { id: storedToken!.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const staffCookie = await login(staffEmail);
    expect((await request("/portal/check-in/redeem", "POST", { token: expiredQr.payload.data.token }, staffCookie)).response.status).toBe(400);

    const qr = await request(`/portal/appointments/${appointment.payload.data.appointment.id}/check-in-token`, "POST", { patientId }, patientCookie);
    expect(qr.response.status).toBe(201);
    expect((await request("/portal/check-in/redeem", "POST", { token: qr.payload.data.token }, familyCookie)).response.status).toBe(403);
    const redemptions = await Promise.all([
      request("/portal/check-in/redeem", "POST", { token: qr.payload.data.token }, staffCookie),
      request("/portal/check-in/redeem", "POST", { token: qr.payload.data.token }, staffCookie),
    ]);
    expect(redemptions.filter((result) => result.response.status === 201)).toHaveLength(1);
    expect(redemptions.every((result) => [201, 409].includes(result.response.status))).toBe(true);
    const checkedIn = redemptions.find((result) => result.response.status === 201)!;
    expect(checkedIn.payload.data.entry.sequence).toBe(1);
    expect((await request("/portal/check-in/redeem", "POST", { token: qr.payload.data.token }, staffCookie)).response.status).toBe(400);
    expect((await request(`/portal/queue?patientId=${patientId}`, "GET", undefined, patientCookie)).payload.data[0].status).toBe("WAITING");
    const desk = await request(`/portal/queue/desk?departmentId=${departmentId}`, "GET", undefined, staffCookie);
    expect(desk.response.status).toBe(200);
    expect(desk.payload.data).toHaveLength(1);
    deliveries.failEmail = true;
    const called = await request(`/portal/queue/desk/${desk.payload.data[0].id}`, "PATCH", { status: "CALLED" }, staffCookie);
    expect(called.response.status).toBe(200);
    expect(called.payload.data.notificationDelivery).toContainEqual({ channel: "EMAIL", status: "FAILED" });
    deliveries.failEmail = false;
    const failedNotification = await prisma.portalNotification.findFirst({ where: { userId: patientUserId, category: "QUEUE" }, orderBy: { createdAt: "desc" } });
    expect(failedNotification).toBeTruthy();
    const retried = await request(`/portal/notifications/${failedNotification!.id}/retry`, "POST", {}, patientCookie);
    expect(retried.response.status).toBe(200);
    expect(retried.payload.data.deliveries).toContainEqual({ channel: "EMAIL", status: "SENT" });

    const events = await request(`/portal/journey?patientId=${patientId}`, "GET", undefined, familyCookie);
    expect(events.response.status).toBe(200);
    expect(events.payload.data.some((item: { type: string }) => item.type === "QUEUE")).toBe(true);
    const familyNotifications = await request("/portal/notifications", "GET", undefined, familyCookie);
    expect(familyNotifications.payload.data.items.some((item: { category: string }) => item.category === "QUEUE")).toBe(true);
    expect(JSON.stringify(familyNotifications.payload.data.items)).not.toContain("Portal Patient");
    expect(JSON.stringify(familyNotifications.payload.data.items)).not.toContain(`TST-${tag}`);
    const grantId = familyRegistration.payload.data.grant.id as string;
    await prisma.patientAccessGrant.update({ where: { id: grantId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(`/portal/journey?patientId=${patientId}`, "GET", undefined, familyCookie)).response.status).toBe(404);
    expect((await request("/portal/patients", "GET", undefined, familyCookie)).payload.data).toHaveLength(0);
    await prisma.patientAccessGrant.update({ where: { id: grantId }, data: { expiresAt: new Date(Date.now() + 60_000) } });
    const revoke = await request(`/portal/family/grants/${grantId}/revoke`, "PATCH", {}, patientCookie);
    expect(revoke.response.status).toBe(200);
    expect((await request(`/portal/journey?patientId=${patientId}`, "GET", undefined, familyCookie)).response.status).toBe(404);
    expect((await request("/portal/patients", "GET", undefined, familyCookie)).payload.data).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { correlationId: runId, action: { in: ["REGISTER", "INVITE", "CHECK_IN", "REVOKE"] } } })).toBeGreaterThanOrEqual(4);
    expect(await prisma.notificationDelivery.count({ where: { status: "SENT", notification: { userId: patientUserId } } })).toBeGreaterThanOrEqual(3);
    expect(await prisma.notificationDelivery.count({ where: { channel: "SMS", notification: { userId: patientUserId } } })).toBe(0);
    expect(deliveries.email.every((delivery) => !delivery.text.includes(`TST-${tag}`) && !delivery.text.includes("Portal Patient"))).toBe(true);
  });
});
