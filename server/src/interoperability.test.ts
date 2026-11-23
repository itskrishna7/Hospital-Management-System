import { AdmissionStatus, AppointmentStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { ABDM_IG_VERSION, buildFhirExportBundle, FHIR_VERSION, type FhirPatientExportData } from "./fhir-mapping.js";

function patientData(overrides: Partial<FhirPatientExportData> = {}): FhirPatientExportData {
  return {
    id: "synthetic-patient-1",
    patientNumber: "SYN-001",
    firstName: "Asha",
    lastName: "Example",
    dateOfBirth: new Date("1990-04-15T00:00:00.000Z"),
    phone: "+910000000000",
    appointments: [
      {
        id: "synthetic-appointment-1",
        startsAt: new Date("2026-01-15T09:00:00.000Z"),
        endsAt: new Date("2026-01-15T09:30:00.000Z"),
        status: AppointmentStatus.SCHEDULED,
        doctor: { id: "synthetic-doctor-1", user: { name: "Dr Example" } },
        department: { id: "synthetic-department-1", name: "General Medicine" },
      },
      {
        id: "synthetic-appointment-2",
        startsAt: new Date("2026-01-16T09:00:00.000Z"),
        endsAt: new Date("2026-01-16T09:30:00.000Z"),
        status: AppointmentStatus.CONFIRMED,
        doctor: { id: "synthetic-doctor-1", user: { name: "Dr Example" } },
        department: { id: "synthetic-department-1", name: "General Medicine" },
      },
      {
        id: "synthetic-appointment-3",
        startsAt: new Date("2026-01-17T09:00:00.000Z"),
        endsAt: new Date("2026-01-17T09:30:00.000Z"),
        status: AppointmentStatus.COMPLETED,
        doctor: { id: "synthetic-doctor-1", user: { name: "Dr Example" } },
        department: { id: "synthetic-department-1", name: "General Medicine" },
      },
      {
        id: "synthetic-appointment-4",
        startsAt: new Date("2026-01-18T09:00:00.000Z"),
        endsAt: new Date("2026-01-18T09:30:00.000Z"),
        status: AppointmentStatus.CANCELLED,
        doctor: { id: "synthetic-doctor-1", user: { name: "Dr Example" } },
        department: { id: "synthetic-department-1", name: "General Medicine" },
      },
    ],
    admissions: [
      {
        id: "synthetic-admission-active",
        admittedAt: new Date("2026-01-10T12:00:00.000Z"),
        dischargedAt: null,
        status: AdmissionStatus.ACTIVE,
        bed: { ward: { department: { id: "synthetic-department-1", name: "General Medicine" } } },
      },
      {
        id: "synthetic-admission-discharged",
        admittedAt: new Date("2025-12-10T12:00:00.000Z"),
        dischargedAt: new Date("2025-12-12T14:00:00.000Z"),
        status: AdmissionStatus.DISCHARGED,
        bed: { ward: { department: { id: "synthetic-department-1", name: "General Medicine" } } },
      },
    ],
    ...overrides,
  };
}

describe("local ABDM FHIR R4 export mapping", () => {
  it("creates profiled resources with resolvable local references and mapped statuses", () => {
    const bundle = buildFhirExportBundle(patientData(), new Date("2026-02-01T00:00:00.000Z"));
    const resources = bundle.entry.map(({ resource }) => resource);
    const patientEntry = bundle.entry.find(({ resource }) => resource.resourceType === "Patient");
    const appointments = resources.filter((resource) => resource.resourceType === "Appointment");
    const encounters = resources.filter((resource) => resource.resourceType === "Encounter");
    const fullUrls = new Set(bundle.entry.map(({ fullUrl }) => fullUrl));

    expect(bundle).toMatchObject({
      resourceType: "Bundle",
      type: "collection",
      timestamp: "2026-02-01T00:00:00.000Z",
    });
    expect(FHIR_VERSION).toBe("4.0.1");
    expect(ABDM_IG_VERSION).toBe("6.5.0");
    expect(patientEntry?.resource).toMatchObject({
      resourceType: "Patient",
      identifier: [{ value: "SYN-001" }],
      name: [{ text: "Asha Example", family: "Example", given: ["Asha"] }],
      birthDate: "1990-04-15",
    });
    expect(appointments.map((resource) => resource.status)).toEqual(["proposed", "booked", "fulfilled", "cancelled"]);
    expect(encounters.map((resource) => resource.status)).toEqual(["in-progress", "finished"]);
    expect(resources.filter((resource) => resource.resourceType === "Practitioner")).toHaveLength(1);
    expect(resources.filter((resource) => resource.resourceType === "Organization")).toHaveLength(1);

    for (const resource of resources) {
      expect(String(resource.id)).toMatch(/^[A-Za-z0-9.-]{1,64}$/);
    }
    expect(encounters[0]?.meta).toMatchObject({
      profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/Encounter"],
    });
    expect(resources.filter((resource) => resource.resourceType !== "Encounter").every((resource) => !resource.meta)).toBe(true);

    const patientReference = patientEntry?.fullUrl;
    expect(patientReference).toBeTruthy();
    for (const appointment of appointments) {
      const participants = appointment.participant as Array<{ actor: { reference: string } }>;
      expect(participants.some(({ actor }) => actor.reference === patientReference)).toBe(true);
      expect(participants.every(({ actor }) => fullUrls.has(actor.reference))).toBe(true);
      expect(appointment).not.toHaveProperty("serviceProvider");
    }
    expect((encounters[0]?.subject as { reference: string }).reference).toBe(patientReference);
    expect(fullUrls.has((encounters[0]?.serviceProvider as { reference: string }).reference)).toBe(true);
  });

  it("exports demographics without inventing operational history when none exists", () => {
    const bundle = buildFhirExportBundle(patientData({ appointments: [], admissions: [] }));

    expect(bundle.entry).toHaveLength(1);
    expect(bundle.entry[0]?.resource.resourceType).toBe("Patient");
    expect(JSON.stringify(bundle)).not.toContain("diagnosis");
    expect(JSON.stringify(bundle)).not.toContain("passwordHash");
  });
});
