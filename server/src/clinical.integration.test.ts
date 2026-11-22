import { once } from "node:events";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import { Role } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "./app.js";
import { prisma } from "./db.js";

const tag = `phase2${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const runId = `phase2-${tag}`;
const password = "Phase-Two-Integration-Password-2026!";
const emails = {
  doctor: `${tag}-doctor@example.test`,
  nurse: `${tag}-nurse@example.test`,
  admin: `${tag}-admin@example.test`,
  receptionist: `${tag}-receptionist@example.test`,
  pharmacist: `${tag}-pharmacist@example.test`,
};
const fieldKey = `${tag}_recordFlag`;
const sku = `${tag}-SKU`;
const triageCode = `${tag}-CAT`;
let departmentId = "";
let patientId = "";
let admissionId = "";
let doctorId = "";
let nurseId = "";
let receptionistId = "";
let pharmacistId = "";
let medicineId = "";
let triageCategoryId = "";
let baseUrl = "";
let server: ReturnType<typeof app.listen>;

async function request(path: string, method = "GET", body?: unknown, cookie?: string) {
  const url = new URL(`${baseUrl}/api/v1${path}`);
  return new Promise<{ response: { status: number; headers: Headers }; payload: any }>((resolve, reject) => {
    const req = http.request(url, {
      method,
      localAddress: "127.0.0.3",
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

describe("Phase 2 clinical-care PostgreSQL integration", () => {
  beforeAll(async () => {
    const department = await prisma.department.create({ data: { name: `Phase 2 ${tag}` } });
    departmentId = department.id;
    const passwordHash = await bcrypt.hash(password, 12);
    const [doctor, nurse, admin, receptionist, pharmacist] = await Promise.all([
      prisma.user.create({ data: { email: emails.doctor, name: "Phase 2 Doctor", role: Role.DOCTOR, passwordHash } }),
      prisma.user.create({ data: { email: emails.nurse, name: "Phase 2 Nurse", role: Role.NURSE, passwordHash } }),
      prisma.user.create({ data: { email: emails.admin, name: "Phase 2 Admin", role: Role.ADMIN, passwordHash } }),
      prisma.user.create({ data: { email: emails.receptionist, name: "Phase 2 Receptionist", role: Role.RECEPTIONIST, passwordHash } }),
      prisma.user.create({ data: { email: emails.pharmacist, name: "Phase 2 Pharmacist", role: Role.PHARMACIST, passwordHash } }),
    ]);
    doctorId = doctor.id;
    nurseId = nurse.id;
    receptionistId = receptionist.id;
    pharmacistId = pharmacist.id;
    await prisma.doctor.create({ data: { userId: doctor.id, departmentId, specialty: "Integration testing" } });
    const patient = await prisma.patient.create({
      data: {
        patientNumber: `TST-${tag}`,
        firstName: "Phase",
        lastName: "Clinical",
        dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
        phone: "+10000000000",
        departmentId,
      },
    });
    patientId = patient.id;
    const ward = await prisma.ward.create({ data: { name: `Phase 2 Ward ${tag}`, departmentId } });
    const bed = await prisma.bed.create({ data: { label: `B-${tag}`, wardId: ward.id, status: "OCCUPIED" } });
    const admission = await prisma.admission.create({ data: { patientId, bedId: bed.id } });
    admissionId = admission.id;
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
      await prisma.medicationAdministration.deleteMany({ where: { patientId } });
      await prisma.prescriptionItem.deleteMany({ where: { prescription: { patientId } } });
      await prisma.prescription.deleteMany({ where: { patientId } });
      await prisma.clinicalRecord.deleteMany({ where: { patientId } });
      await prisma.nursingTask.deleteMany({ where: { patientId } });
      await prisma.nursingHandover.deleteMany({ where: { patientId } });
      await prisma.emergencyVisit.deleteMany({ where: { patientId } });
    }
    await prisma.clinicalFieldDefinition.deleteMany({ where: { key: fieldKey } });
    if (triageCategoryId) await prisma.emergencyTriageCategory.deleteMany({ where: { id: triageCategoryId } });
    if (medicineId) await prisma.medicine.deleteMany({ where: { id: medicineId } });
    const users = await prisma.user.findMany({ where: { email: { in: Object.values(emails) } }, select: { id: true } });
    const userIds = users.map((user) => user.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { correlationId: runId }] } });
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.loginHistory.deleteMany({ where: { userId: { in: userIds }, email: { in: Object.values(emails) } } });
    if (admissionId) await prisma.admission.deleteMany({ where: { id: admissionId } });
    await prisma.bed.deleteMany({ where: { label: `B-${tag}` } });
    await prisma.ward.deleteMany({ where: { name: `Phase 2 Ward ${tag}` } });
    await prisma.doctor.deleteMany({ where: { userId: { in: userIds } } });
    if (patientId) await prisma.patient.deleteMany({ where: { id: patientId } });
    if (departmentId) await prisma.department.deleteMany({ where: { id: departmentId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }, 30_000);

  it("enforces clinician authorship and scopes draft, signature, and amendment versions", async () => {
    const adminCookie = await login(emails.admin);
    const field = await request("/clinical/fields", "POST", {
      key: fieldKey,
      label: "Configured integration field",
      type: "SINGLE_SELECT",
      appliesTo: ["CONSULTATION"],
      options: ["value_a", "value_b"],
      required: true,
    }, adminCookie);
    expect(field.response.status).toBe(201);

    const doctorCookie = await login(emails.doctor);
    const nurseCookie = await login(emails.nurse);
    const forbiddenType = await request("/clinical/records", "POST", {
      patientId,
      type: "CONSULTATION",
      title: "Not nurse-authored",
    }, nurseCookie);
    expect(forbiddenType.response.status).toBe(403);
    const missingConfiguredField = await request("/clinical/records", "POST", {
      patientId,
      type: "CONSULTATION",
      title: "Missing configured value",
    }, doctorCookie);
    expect(missingConfiguredField.response.status).toBe(400);

    const created = await request("/clinical/records", "POST", {
      patientId,
      type: "CONSULTATION",
      title: "Initial draft",
      structuredData: { [fieldKey]: "value_a" },
    }, doctorCookie);
    expect(created.response.status).toBe(201);
    const revised = await request(`/clinical/records/${created.payload.data.id}`, "PATCH", {
      title: "Revised draft",
      narrative: "Clinician-authored integration note.",
      structuredData: { [fieldKey]: "value_b" },
    }, doctorCookie);
    expect(revised.response.status).toBe(200);
    expect(revised.payload.data.version).toBe(2);
    expect(revised.payload.data.previousVersionId).toBe(created.payload.data.id);
    expect((await prisma.clinicalRecord.findUnique({ where: { id: created.payload.data.id } }))?.status).toBe("SUPERSEDED");

    const nurseSign = await request(`/clinical/records/${revised.payload.data.id}/sign`, "POST", { reviewConfirmed: true }, nurseCookie);
    expect(nurseSign.response.status).toBe(403);
    expect((await request(`/clinical/records/${revised.payload.data.id}/sign`, "POST", {}, doctorCookie)).response.status).toBe(400);
    const signed = await request(`/clinical/records/${revised.payload.data.id}/sign`, "POST", { reviewConfirmed: true }, doctorCookie);
    expect(signed.response.status).toBe(200);
    expect(signed.payload.data.status).toBe("SIGNED");
    expect(signed.payload.data.signedById).toBe(doctorId);
    expect((await request(`/clinical/records/${revised.payload.data.id}`, "PATCH", {
      title: "Attempt to alter signed record",
      structuredData: { [fieldKey]: "value_a" },
    }, doctorCookie)).response.status).toBe(409);

    const amendment = await request(`/clinical/records/${revised.payload.data.id}/amend`, "POST", {
      reason: "Correction based on clinician review.",
      narrative: "Amended clinician-authored note.",
    }, doctorCookie);
    expect(amendment.response.status).toBe(201);
    expect(amendment.payload.data.previousVersionId).toBe(revised.payload.data.id);
    expect(amendment.payload.data.revisionReason).toBe("Correction based on clinician review.");
    expect((await request(`/clinical/records?patientId=${patientId}`, "GET", undefined, adminCookie)).response.status).toBe(403);
    expect(await prisma.auditLog.count({ where: { correlationId: runId, action: { in: ["CREATE_DRAFT", "CREATE_VERSION", "SIGN", "AMEND"] } } })).toBeGreaterThanOrEqual(4);
  });

  it("requires configured formulary choices and clinician signature before nursing medication records", async () => {
    const pharmacistCookie = await login(emails.pharmacist);
    const medicine = await request("/formulary", "POST", {
      name: "Phase 2 Configurable Medication",
      sku,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      dosageForms: ["configured_form"],
      strengths: ["configured_strength"],
      routes: ["configured_route"],
    }, pharmacistCookie);
    expect(medicine.response.status).toBe(201);
    medicineId = medicine.payload.data.id;

    const doctorCookie = await login(emails.doctor);
    const invalid = await request("/prescriptions", "POST", {
      patientId,
      items: [{
        medicineId,
        dose: "clinician-entered dose",
        strength: "configured_strength",
        dosageForm: "configured_form",
        route: "unconfigured_route",
        frequency: "clinician-entered frequency",
        quantity: 1,
      }],
    }, doctorCookie);
    expect(invalid.response.status).toBe(400);
    const draft = await request("/prescriptions", "POST", {
      patientId,
      items: [{
        medicineId,
        dose: "clinician-entered dose",
        strength: "configured_strength",
        dosageForm: "configured_form",
        route: "configured_route",
        frequency: "clinician-entered frequency",
        quantity: 1,
      }],
    }, doctorCookie);
    expect(draft.response.status).toBe(201);
    expect(draft.payload.data.status).toBe("DRAFT");
    const revised = await request(`/prescriptions/${draft.payload.data.id}`, "PATCH", {
      items: [{
        medicineId,
        dose: "clinician-revised dose",
        strength: "configured_strength",
        dosageForm: "configured_form",
        route: "configured_route",
        frequency: "clinician-entered frequency",
        quantity: 1,
      }],
    }, doctorCookie);
    expect(revised.response.status).toBe(200);
    expect(revised.payload.data.items[0].dose).toBe("clinician-revised dose");
    const nurseCookie = await login(emails.nurse);
    expect((await request(`/prescriptions/${draft.payload.data.id}/sign`, "POST", { reviewConfirmed: true }, nurseCookie)).response.status).toBe(403);
    expect((await request(`/prescriptions/${draft.payload.data.id}/sign`, "POST", {}, doctorCookie)).response.status).toBe(400);
    expect((await request(`/prescriptions/${draft.payload.data.id}/sign`, "POST", { reviewConfirmed: true }, doctorCookie)).response.status).toBe(200);

    const listed = await request(`/prescriptions?patientId=${patientId}`, "GET", undefined, pharmacistCookie);
    expect(listed.response.status).toBe(200);
    expect(listed.payload.data.map((item: { id: string }) => item.id)).toContain(draft.payload.data.id);
    const administration = await request("/nursing/medication-administrations", "POST", {
      patientId,
      prescriptionItemId: revised.payload.data.items[0].id,
      administeredDose: "recorded actual dose",
      administeredRoute: "recorded actual route",
      notes: "Administration recorded by integration workflow.",
    }, nurseCookie);
    expect(administration.response.status).toBe(201);
    expect(administration.payload.data.administeredById).toBe(nurseId);
    expect((await request(`/nursing/medication-administrations?patientId=${patientId}`, "GET", undefined, nurseCookie)).payload.data).toHaveLength(1);
    const missingCancelReason = await request(`/prescriptions/${draft.payload.data.id}/cancel`, "POST", { reason: "short" }, doctorCookie);
    expect(missingCancelReason.response.status).toBe(400);
    const cancelled = await request(`/prescriptions/${draft.payload.data.id}/cancel`, "POST", { reason: "Integration workflow cancellation." }, doctorCookie);
    expect(cancelled.response.status).toBe(200);
    expect(cancelled.payload.data.status).toBe("CANCELLED");
    expect(await prisma.auditLog.count({ where: { entity: "PRESCRIPTION", entityId: draft.payload.data.id, action: "CANCEL" } })).toBe(1);
  });

  it("supports scoped nursing work and configurable, manually assigned emergency triage", async () => {
    const doctorCookie = await login(emails.doctor);
    const nurseCookie = await login(emails.nurse);
    const nurseTask = await request("/nursing/tasks", "POST", {
      patientId,
      admissionId,
      title: "Integration nursing task",
      assignedToId: nurseId,
    }, doctorCookie);
    expect(nurseTask.response.status).toBe(201);
    expect((await request(`/nursing/tasks?patientId=${patientId}`, "GET", undefined, nurseCookie)).payload.data).toHaveLength(1);
    expect((await request(`/nursing/tasks/${nurseTask.payload.data.id}/status`, "PATCH", { status: "COMPLETED" }, nurseCookie)).response.status).toBe(409);
    expect((await request(`/nursing/tasks/${nurseTask.payload.data.id}/status`, "PATCH", { status: "IN_PROGRESS" }, nurseCookie)).response.status).toBe(200);
    expect((await request(`/nursing/tasks/${nurseTask.payload.data.id}/status`, "PATCH", { status: "COMPLETED" }, nurseCookie)).response.status).toBe(200);

    const handover = await request("/nursing/handovers", "POST", {
      patientId,
      admissionId,
      summary: "Integration handover summary.",
      receivedById: nurseId,
    }, nurseCookie);
    expect(handover.response.status).toBe(201);
    expect((await request(`/nursing/handovers?patientId=${patientId}`, "GET", undefined, nurseCookie)).payload.data).toHaveLength(1);

    const adminCookie = await login(emails.admin);
    const category = await request("/emergency/triage-categories", "POST", {
      code: triageCode,
      label: "Configured integration category",
      priority: 17,
    }, adminCookie);
    expect(category.response.status).toBe(201);
    triageCategoryId = category.payload.data.id;
    const receptionistCookie = await login(emails.receptionist);
    const createdVisit = await request("/emergency/visits", "POST", {
      patientId,
      chiefComplaint: "Integration complaint",
    }, receptionistCookie);
    expect(createdVisit.response.status).toBe(201);
    expect((await request("/emergency/visits", "POST", {
      patientId,
      chiefComplaint: "Receptionist cannot triage",
      triageCategoryId,
    }, receptionistCookie)).response.status).toBe(403);

    const triaged = await request(`/emergency/visits/${createdVisit.payload.data.id}/triage`, "PATCH", {
      triageCategoryId,
      triageNotes: "Manually classified by authorized clinician.",
    }, nurseCookie);
    expect(triaged.response.status).toBe(200);
    expect(triaged.payload.data.triagedById).toBe(nurseId);
    const triageRecord = await request("/clinical/records", "POST", {
      patientId,
      type: "TRIAGE_NOTE",
      title: "Emergency clinician note",
      emergencyVisitId: createdVisit.payload.data.id,
    }, nurseCookie);
    expect(triageRecord.response.status).toBe(201);
    expect((await request(`/clinical/records/${triageRecord.payload.data.id}/sign`, "POST", { reviewConfirmed: true }, nurseCookie)).response.status).toBe(200);
    expect((await request(`/emergency/visits/${createdVisit.payload.data.id}/status`, "PATCH", { status: "IN_PROGRESS" }, nurseCookie)).response.status).toBe(200);
    const admitted = await request(`/emergency/visits/${createdVisit.payload.data.id}/status`, "PATCH", {
      status: "ADMITTED",
      admissionId,
    }, nurseCookie);
    expect(admitted.response.status).toBe(200);
    expect(admitted.payload.data.status).toBe("ADMITTED");
  });
});
