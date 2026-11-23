import { createHash, randomUUID } from "node:crypto";

export const FHIR_VERSION = "4.0.1";
export const ABDM_IG_VERSION = "6.5.0";
export const FHIR_EXPORT_MAX_RECORDS_PER_TYPE = 250;

const ENCOUNTER_PROFILE_URL = "https://nrces.in/ndhm/fhir/r4/StructureDefinition/Encounter";

export type FhirPatientExportData = {
  id: string;
  patientNumber: string;
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  phone: string;
  appointments: Array<{
    id: string;
    startsAt: Date;
    endsAt: Date;
    status: string;
    doctor: { id: string; user: { name: string } };
    department: { id: string; name: string };
  }>;
  admissions: Array<{
    id: string;
    admittedAt: Date;
    dischargedAt: Date | null;
    status: string;
    bed: { ward: { department: { id: string; name: string } } };
  }>;
};

type FhirResource = Record<string, unknown> & { resourceType: string; id: string };
export type FhirExportBundle = {
  resourceType: "Bundle";
  id: string;
  type: "collection";
  timestamp: string;
  entry: Array<{ fullUrl: string; resource: FhirResource }>;
};

function stableFhirId(resourceType: string, localId: string) {
  return createHash("sha256").update(`${resourceType}:${localId}`).digest("hex").slice(0, 32);
}

function appointmentStatus(status: string) {
  switch (status) {
    case "CONFIRMED": return "booked";
    case "COMPLETED": return "fulfilled";
    case "CANCELLED": return "cancelled";
    default: return "proposed";
  }
}

function encounterStatus(status: string) {
  return status === "ACTIVE" ? "in-progress" : "finished";
}

export function buildFhirExportBundle(patient: FhirPatientExportData, timestamp = new Date()): FhirExportBundle {
  const entries: FhirExportBundle["entry"] = [];
  const organizationRefs = new Map<string, string>();
  const practitionerRefs = new Map<string, string>();

  const addResource = (resource: FhirResource) => {
    const fullUrl = `urn:uuid:${randomUUID()}`;
    entries.push({ fullUrl, resource });
    return fullUrl;
  };
  const organizationReference = (department: { id: string; name: string }) => {
    const existing = organizationRefs.get(department.id);
    if (existing) return existing;
    const reference = addResource({
      resourceType: "Organization",
      id: stableFhirId("Organization", department.id),
      identifier: [{
        type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "XX", display: "Organization identifier" }] },
        system: "https://mediverse.local/fhir/NamingSystem/department-id",
        value: stableFhirId("Organization", department.id),
      }],
      active: true,
      name: department.name,
    });
    organizationRefs.set(department.id, reference);
    return reference;
  };

  const patientRef = addResource({
    resourceType: "Patient",
    id: stableFhirId("Patient", patient.id),
    identifier: [{
      type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MR", display: "Medical record number" }] },
      system: "https://mediverse.local/fhir/NamingSystem/patient-number",
      value: patient.patientNumber,
    }],
    name: [{ text: `${patient.firstName} ${patient.lastName}`, family: patient.lastName, given: [patient.firstName] }],
    telecom: [{ system: "phone", value: patient.phone }],
    gender: "unknown",
    birthDate: patient.dateOfBirth.toISOString().slice(0, 10),
  });

  for (const appointment of patient.appointments) {
    let practitionerRef = practitionerRefs.get(appointment.doctor.id);
    if (!practitionerRef) {
      practitionerRef = addResource({
        resourceType: "Practitioner",
        id: stableFhirId("Practitioner", appointment.doctor.id),
        identifier: [{
          type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "PRN", display: "Provider number" }] },
          system: "https://mediverse.local/fhir/NamingSystem/practitioner-id",
          value: stableFhirId("Practitioner", appointment.doctor.id),
        }],
        active: true,
        name: [{ text: appointment.doctor.user.name }],
      });
      practitionerRefs.set(appointment.doctor.id, practitionerRef);
    }

    entries.push({
      fullUrl: `urn:uuid:${randomUUID()}`,
      resource: {
        resourceType: "Appointment",
        id: stableFhirId("Appointment", appointment.id),
        identifier: [{ system: "https://mediverse.local/fhir/NamingSystem/appointment-id", value: stableFhirId("Appointment", appointment.id) }],
        status: appointmentStatus(appointment.status),
        start: appointment.startsAt.toISOString(),
        end: appointment.endsAt.toISOString(),
        participant: [
          { actor: { reference: patientRef, display: `${patient.firstName} ${patient.lastName}` }, status: "accepted" },
          { actor: { reference: practitionerRef, display: appointment.doctor.user.name }, status: "accepted" },
        ],
      },
    });
  }

  for (const admission of patient.admissions) {
    const department = admission.bed.ward.department;
    const period: Record<string, string> = { start: admission.admittedAt.toISOString() };
    if (admission.dischargedAt) period.end = admission.dischargedAt.toISOString();
    entries.push({
      fullUrl: `urn:uuid:${randomUUID()}`,
      resource: {
        resourceType: "Encounter",
        id: stableFhirId("Encounter", admission.id),
        meta: { profile: [ENCOUNTER_PROFILE_URL] },
        identifier: [{ system: "https://mediverse.local/fhir/NamingSystem/admission-id", value: stableFhirId("Encounter", admission.id) }],
        status: encounterStatus(admission.status),
        class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "IMP", display: "inpatient encounter" },
        subject: { reference: patientRef },
        serviceProvider: { reference: organizationReference(department) },
        period,
      },
    });
  }

  return {
    resourceType: "Bundle",
    id: randomUUID(),
    type: "collection",
    timestamp: timestamp.toISOString(),
    entry: entries,
  };
}
