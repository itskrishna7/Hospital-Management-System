import { once } from "node:events";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import { Role } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "./app.js";
import { prisma } from "./db.js";
import { hashToken } from "./auth.js";
import { createTotpCode, hashRecoveryCode } from "./mfa.js";

const runId = `phase1-${crypto.randomUUID()}`;
const doctorEmail = `${runId}-doctor@example.test`;
const otherDoctorEmail = `${runId}-other-doctor@example.test`;
const adminEmail = `${runId}-admin@example.test`;
const missingEmail = `${runId}-missing@example.test`;
const rateLimitedEmail = `${runId}-rate@example.test`;
const departmentName = `Phase 1 ${runId}`;
const otherDepartmentName = `Phase 1 Other ${runId}`;
const scopedPatientNumbers = [`TST-${runId}-A`, `TST-${runId}-B`];
const doctorPassword = "Doctor-Test-Password-2026!";
const adminPassword = "Admin-Test-Password-2026!";
const newPassword = "Doctor-Changed-Password-2026!";
const testEmails = [doctorEmail, otherDoctorEmail, adminEmail, missingEmail, rateLimitedEmail];
let doctorId = "";
let otherDoctorId = "";
let adminId = "";
let departmentIds: string[] = [];
let appointmentIds: string[] = [];
let baseUrl = "";
let server: ReturnType<typeof app.listen>;

async function request(path: string, method = "GET", body?: unknown, cookie?: string) {
  const url = new URL(`${baseUrl}/api/v1${path}`);
  return new Promise<{ response: { status: number; headers: Headers }; payload: any }>((resolve, reject) => {
    const req = http.request(url, {
      method,
      localAddress: "127.0.0.2",
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

function responseCookie(response: Response) {
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";")[0];
}

async function login(email: string, password: string) {
  return request("/auth/login", "POST", { email, password });
}

describe("Phase 1 PostgreSQL authentication integration", () => {
  beforeAll(async () => {
    const database = await prisma.$queryRaw<Array<{ database_name: string }>>`SELECT current_database() AS database_name`;
    expect(database[0]?.database_name).toBe("mediverse");
    const tableRows = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const appTables = tableRows.map((row) => row.table_name).filter((name) => name !== "_prisma_migrations");
    expect(appTables).toEqual(expect.arrayContaining([
      "MfaRecoveryCode",
      "ClinicalFieldDefinition",
      "ClinicalRecord",
      "Prescription",
      "PrescriptionItem",
      "NursingTask",
      "NursingHandover",
      "MedicationAdministration",
      "EmergencyTriageCategory",
      "EmergencyVisit",
    ]));

    const [department, otherDepartment] = await Promise.all([
      prisma.department.create({ data: { name: departmentName } }),
      prisma.department.create({ data: { name: otherDepartmentName } }),
    ]);
    departmentIds = [department.id, otherDepartment.id];
    const [doctor, otherDoctor, admin] = await Promise.all([
      prisma.user.create({
        data: { email: doctorEmail, name: "Phase 1 Integration Doctor", role: Role.DOCTOR, passwordHash: await bcrypt.hash(doctorPassword, 12) },
      }),
      prisma.user.create({
        data: { email: otherDoctorEmail, name: "Phase 1 Other Integration Doctor", role: Role.DOCTOR, passwordHash: await bcrypt.hash(doctorPassword, 12) },
      }),
      prisma.user.create({
        data: { email: adminEmail, name: "Phase 1 Integration Admin", role: Role.ADMIN, passwordHash: await bcrypt.hash(adminPassword, 12) },
      }),
    ]);
    doctorId = doctor.id;
    otherDoctorId = otherDoctor.id;
    adminId = admin.id;
    await prisma.doctor.createMany({
      data: [
        { userId: doctor.id, departmentId: department.id, specialty: "Integration testing" },
        { userId: otherDoctor.id, departmentId: otherDepartment.id, specialty: "Other integration testing" },
      ],
    });
    await prisma.patient.createMany({
      data: scopedPatientNumbers.map((patientNumber, index) => ({
        patientNumber,
        firstName: "Phase",
        lastName: index === 0 ? "Scoped" : "Unscoped",
        dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
        phone: "+10000000000",
        departmentId: departmentIds[index],
      })),
    });
    const [ownPatient, otherPatient] = await Promise.all(
      scopedPatientNumbers.map((patientNumber) => prisma.patient.findUniqueOrThrow({ where: { patientNumber } })),
    );
    const appointments = await Promise.all([
      prisma.appointment.create({
        data: { patientId: ownPatient.id, doctorId: (await prisma.doctor.findUniqueOrThrow({ where: { userId: doctor.id } })).id, departmentId: department.id, startsAt: new Date(), endsAt: new Date(Date.now() + 30 * 60_000) },
      }),
      prisma.appointment.create({
        data: { patientId: otherPatient.id, doctorId: (await prisma.doctor.findUniqueOrThrow({ where: { userId: otherDoctor.id } })).id, departmentId: otherDepartment.id, startsAt: new Date(), endsAt: new Date(Date.now() + 30 * 60_000) },
      }),
    ]);
    appointmentIds = appointments.map((appointment) => appointment.id);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    if (server) {
      server.close();
      await once(server, "close");
    }
    const users = await prisma.user.findMany({ where: { email: { in: testEmails } }, select: { id: true } });
    const userIds = users.map((user) => user.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { correlationId: runId }] } });
    await prisma.loginHistory.deleteMany({ where: { OR: [{ email: { in: testEmails } }, { userId: { in: userIds } }] } });
    await prisma.appointment.deleteMany({ where: { id: { in: appointmentIds } } });
    await prisma.doctor.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.patient.deleteMany({ where: { patientNumber: { in: scopedPatientNumbers } } });
    await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }, 30_000);

  it("verifies the live database and denies anonymous access to sensitive APIs", async () => {
    const [patients, invoices, registration] = await Promise.all([
      request("/patients"),
      request("/invoices"),
      request("/admin/users", "POST", { email: `${runId}-no-auth@example.test`, name: "Denied", password: "No-Auth-Password-2026!", role: "DOCTOR" }),
    ]);
    expect(patients.response.status).toBe(401);
    expect(invoices.response.status).toBe(401);
    expect(registration.response.status).toBe(401);
  });

  it("records invalid credentials without disclosing whether the account exists", async () => {
    const invalid = await login(doctorEmail, "Wrong-Password-2026!");
    const unknown = await login(missingEmail, "Wrong-Password-2026!");
    expect(invalid.response.status).toBe(401);
    expect(unknown.response.status).toBe(401);
    expect(invalid.payload).toEqual(unknown.payload);
    const history = await prisma.loginHistory.count({
      where: { email: { in: [doctorEmail, missingEmail] }, successful: false, failureReason: "INVALID_CREDENTIALS" },
    });
    expect(history).toBe(2);
    const audit = await prisma.auditLog.count({ where: { correlationId: runId, action: "LOGIN_FAILED", entity: "AUTHENTICATION", success: false } });
    expect(audit).toBe(2);
  });

  it("limits repeated failures per email and source IP", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login(rateLimitedEmail, "Wrong-Password-2026!")).response.status).toBe(401);
    }
    expect((await login(rateLimitedEmail, "Wrong-Password-2026!")).response.status).toBe(429);
  });

  it("persists sessions, enforces role permissions, audits patient reads, and revokes logout", async () => {
    const signedIn = await login(doctorEmail, doctorPassword);
    expect(signedIn.response.status).toBe(200);
    expect(signedIn.payload.data.user.role).toBe("DOCTOR");
    const doctorCookie = responseCookie(signedIn.response);
    const token = decodeURIComponent(doctorCookie.split("=")[1]);
    const session = await prisma.session.findUnique({ where: { tokenHash: hashToken(token) } });
    expect(session?.userId).toBe(doctorId);
    expect(session?.tokenHash).not.toBe(token);

    const me = await request("/auth/me", "GET", undefined, doctorCookie);
    expect(me.response.status).toBe(200);
    expect(me.payload.data.user.email).toBe(doctorEmail);

    const invoices = await request("/invoices", "GET", undefined, doctorCookie);
    expect(invoices.response.status).toBe(403);
    const summary = await request("/dashboard/summary", "GET", undefined, doctorCookie);
    expect(summary.response.status).toBe(200);
    expect(Object.hasOwn(summary.payload.data, "revenue")).toBe(false);
    const patients = await request("/patients", "GET", undefined, doctorCookie);
    expect(patients.response.status).toBe(200);
    const scopedNumbers = patients.payload.data.items.map((patient: { patientNumber: string }) => patient.patientNumber);
    expect(scopedNumbers).toContain(scopedPatientNumbers[0]);
    expect(scopedNumbers).not.toContain(scopedPatientNumbers[1]);
    const otherPatient = await prisma.patient.findUniqueOrThrow({ where: { patientNumber: scopedPatientNumbers[1] } });
    const hiddenPatientUpdate = await request(`/patients/${otherPatient.id}`, "PATCH", { phone: "+19999999999" }, doctorCookie);
    expect(hiddenPatientUpdate.response.status).toBe(404);
    const appointments = await request("/appointments", "GET", undefined, doctorCookie);
    expect(appointments.response.status).toBe(200);
    expect(appointments.payload.data.map((appointment: { id: string }) => appointment.id)).toContain(appointmentIds[0]);
    expect(appointments.payload.data.map((appointment: { id: string }) => appointment.id)).not.toContain(appointmentIds[1]);
    const hiddenAppointmentUpdate = await request(`/appointments/${appointmentIds[1]}/status`, "PATCH", { status: "CANCELLED" }, doctorCookie);
    expect(hiddenAppointmentUpdate.response.status).toBe(404);
    expect(await prisma.auditLog.count({ where: { userId: doctorId, action: "READ", entity: "PATIENT" } })).toBe(1);

    const logout = await request("/auth/logout", "POST", {}, doctorCookie);
    expect(logout.response.status).toBe(204);
    expect((await prisma.session.findUnique({ where: { id: session!.id } }))?.revokedAt).not.toBeNull();
    expect((await request("/auth/me", "GET", undefined, doctorCookie)).response.status).toBe(401);
  });

  it("rejects expired sessions", async () => {
    const token = crypto.randomBytes(32).toString("base64url");
    await prisma.session.create({
      data: { userId: doctorId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() - 60_000) },
    });
    const expired = await request("/auth/me", "GET", undefined, `mediverse_session=${token}`);
    expect(expired.response.status).toBe(401);
  });

  it("allows administrators to register permitted staff and rejects role escalation", async () => {
    const adminLogin = await login(adminEmail, adminPassword);
    const adminCookie = responseCookie(adminLogin.response);
    const financeSummary = await request("/dashboard/summary", "GET", undefined, adminCookie);
    expect(Object.hasOwn(financeSummary.payload.data, "revenue")).toBe(true);
    const createdEmail = `${runId}-new@example.test`;
    testEmails.push(createdEmail);
    const created = await request("/admin/users", "POST", {
      email: createdEmail,
      name: "Created Integration Staff",
      password: "Created-Staff-Password-2026!",
      role: "LAB_TECHNICIAN",
    }, adminCookie);
    expect(created.response.status).toBe(201);
    expect(created.payload.data.user.passwordHash).toBeUndefined();
    const updatedUser = await request(`/admin/users/${created.payload.data.user.id}`, "PATCH", { role: "PHARMACIST" }, adminCookie);
    expect(updatedUser.response.status).toBe(200);
    expect(updatedUser.payload.data.user.role).toBe("PHARMACIST");
    const escalation = await request("/admin/users", "POST", {
      email: `${runId}-escalation@example.test`,
      name: "Rejected Escalation",
      password: "Rejected-Staff-Password-2026!",
      role: "SUPER_ADMIN",
    }, adminCookie);
    expect(escalation.response.status).toBe(403);
    expect(await prisma.user.findUnique({ where: { email: `${runId}-escalation@example.test` } })).toBeNull();
    expect(await prisma.auditLog.count({ where: { userId: adminId, action: "USER_CREATED", entity: "USER" } })).toBe(1);
  });

  it("enforces TOTP enrollment, challenge verification, single-use recovery, and safe disable", async () => {
    const initialLogin = await login(doctorEmail, doctorPassword);
    let cookie = responseCookie(initialLogin.response);
    const enrollment = await request("/auth/mfa/enroll", "POST", { password: doctorPassword }, cookie);
    expect(enrollment.response.status).toBe(200);
    const secret = enrollment.payload.data.secret as string;
    const enable = await request("/auth/mfa/enable", "POST", { code: createTotpCode(secret, Date.now() + 5_000) }, cookie);
    expect(enable.response.status).toBe(200);
    const recoveryCode = enable.payload.data.recoveryCodes[0] as string;
    const dbUser = await prisma.user.findUnique({ where: { id: doctorId } });
    expect(dbUser?.mfaEnabled).toBe(true);
    expect(dbUser?.mfaSecretEncrypted).not.toBe(secret);

    await request("/auth/logout", "POST", {}, cookie);
    let challenged = await login(doctorEmail, doctorPassword);
    expect(challenged.payload.data.mfaRequired).toBe(true);
    cookie = responseCookie(challenged.response);
    expect((await request("/patients", "GET", undefined, cookie)).response.status).toBe(401);
    const pendingToken = decodeURIComponent(cookie.split("=")[1]);
    const pendingSession = await prisma.session.findUnique({ where: { tokenHash: hashToken(pendingToken) } });
    expect((await request("/auth/logout", "POST", {}, cookie)).response.status).toBe(204);
    expect((await prisma.session.findUnique({ where: { id: pendingSession!.id } }))?.revokedAt).not.toBeNull();
    challenged = await login(doctorEmail, doctorPassword);
    cookie = responseCookie(challenged.response);
    const verified = await request("/auth/mfa/verify", "POST", { code: createTotpCode(secret, Date.now() + 5_000) }, cookie);
    expect(verified.response.status).toBe(200);
    expect((await request("/auth/me", "GET", undefined, cookie)).response.status).toBe(200);

    await request("/auth/logout", "POST", {}, cookie);
    challenged = await login(doctorEmail, doctorPassword);
    cookie = responseCookie(challenged.response);
    const recovered = await request("/auth/mfa/verify", "POST", { code: recoveryCode }, cookie);
    expect(recovered.response.status).toBe(200);
    const storedRecovery = await prisma.mfaRecoveryCode.findUnique({ where: { tokenHash: hashRecoveryCode(recoveryCode) } });
    expect(storedRecovery?.usedAt).not.toBeNull();
    await request("/auth/logout", "POST", {}, cookie);
    challenged = await login(doctorEmail, doctorPassword);
    cookie = responseCookie(challenged.response);
    expect((await request("/auth/mfa/verify", "POST", { code: recoveryCode }, cookie)).response.status).toBe(401);
    await request("/auth/logout", "POST", {}, cookie);
    challenged = await login(doctorEmail, doctorPassword);
    cookie = responseCookie(challenged.response);
    expect((await request("/auth/mfa/verify", "POST", { code: createTotpCode(secret, Date.now() + 5_000) }, cookie)).response.status).toBe(200);

    const disabled = await request("/auth/mfa/disable", "POST", {
      password: doctorPassword,
      code: createTotpCode(secret, Date.now() + 5_000),
    }, cookie);
    expect(disabled.response.status).toBe(200);
    expect((await prisma.user.findUnique({ where: { id: doctorId } }))?.mfaEnabled).toBe(false);
    expect((await request("/auth/me", "GET", undefined, cookie)).response.status).toBe(200);
  });

  it("changes passwords and deactivates accounts with session revocation", async () => {
    const signedIn = await login(doctorEmail, doctorPassword);
    const cookie = responseCookie(signedIn.response);
    const changed = await request("/auth/change-password", "POST", {
      currentPassword: doctorPassword,
      newPassword,
    }, cookie);
    expect(changed.response.status).toBe(200);
    expect((await request("/auth/me", "GET", undefined, cookie)).response.status).toBe(401);
    expect((await login(doctorEmail, doctorPassword)).response.status).toBe(401);
    expect((await login(doctorEmail, newPassword)).response.status).toBe(200);

    const adminLogin = await login(adminEmail, adminPassword);
    const adminCookie = responseCookie(adminLogin.response);
    const deactivated = await request(`/admin/users/${doctorId}`, "PATCH", { active: false }, adminCookie);
    expect(deactivated.response.status).toBe(200);
    expect((await login(doctorEmail, newPassword)).response.status).toBe(401);
  });
});
