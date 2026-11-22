-- CreateEnum
CREATE TYPE "ClinicalRecordType" AS ENUM ('CONSULTATION', 'NURSING_NOTE', 'CARE_PLAN', 'DISCHARGE_SUMMARY', 'TRIAGE_NOTE');

-- CreateEnum
CREATE TYPE "ClinicalRecordStatus" AS ENUM ('DRAFT', 'SIGNED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ClinicalFieldType" AS ENUM ('TEXT', 'NUMBER', 'BOOLEAN', 'DATE', 'SINGLE_SELECT', 'MULTI_SELECT');

-- CreateEnum
CREATE TYPE "PrescriptionStatus" AS ENUM ('DRAFT', 'SIGNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NursingTaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EmergencyVisitStatus" AS ENUM ('WAITING', 'IN_PROGRESS', 'ADMITTED', 'DISCHARGED', 'TRANSFERRED');

-- AlterTable
ALTER TABLE "Medicine" ADD COLUMN     "dosageForms" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "formularyEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "routes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "strengths" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "ClinicalFieldDefinition" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "ClinicalFieldType" NOT NULL,
    "appliesTo" "ClinicalRecordType"[] DEFAULT ARRAY[]::"ClinicalRecordType"[],
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "required" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicalFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicalRecord" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "type" "ClinicalRecordType" NOT NULL,
    "status" "ClinicalRecordStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "narrative" TEXT,
    "structuredData" JSONB NOT NULL DEFAULT '{}',
    "authoredById" TEXT NOT NULL,
    "signedById" TEXT,
    "previousVersionId" TEXT,
    "revisionReason" TEXT,
    "appointmentId" TEXT,
    "admissionId" TEXT,
    "emergencyVisitId" TEXT,
    "signedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicalRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prescription" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "clinicalRecordId" TEXT,
    "status" "PrescriptionStatus" NOT NULL DEFAULT 'DRAFT',
    "prescribedById" TEXT NOT NULL,
    "signedById" TEXT,
    "signedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrescriptionItem" (
    "id" TEXT NOT NULL,
    "prescriptionId" TEXT NOT NULL,
    "medicineId" TEXT NOT NULL,
    "dose" TEXT NOT NULL,
    "strength" TEXT,
    "dosageForm" TEXT,
    "route" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "duration" TEXT,
    "quantity" INTEGER NOT NULL,
    "instructions" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrescriptionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NursingTask" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "admissionId" TEXT,
    "title" TEXT NOT NULL,
    "details" TEXT,
    "status" "NursingTaskStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT NOT NULL,
    "assignedToId" TEXT,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NursingTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NursingHandover" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "admissionId" TEXT,
    "summary" TEXT NOT NULL,
    "sentById" TEXT NOT NULL,
    "receivedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NursingHandover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicationAdministration" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "prescriptionItemId" TEXT NOT NULL,
    "administeredById" TEXT NOT NULL,
    "administeredDose" TEXT NOT NULL,
    "administeredRoute" TEXT NOT NULL,
    "administeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MedicationAdministration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyTriageCategory" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmergencyTriageCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyVisit" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "admissionId" TEXT,
    "chiefComplaint" TEXT NOT NULL,
    "triageNotes" TEXT,
    "status" "EmergencyVisitStatus" NOT NULL DEFAULT 'WAITING',
    "triageCategoryId" TEXT,
    "createdById" TEXT NOT NULL,
    "assignedClinicianId" TEXT,
    "triagedById" TEXT,
    "arrivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "triagedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmergencyVisit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClinicalFieldDefinition_key_key" ON "ClinicalFieldDefinition"("key");

-- CreateIndex
CREATE INDEX "ClinicalFieldDefinition_active_type_idx" ON "ClinicalFieldDefinition"("active", "type");

-- CreateIndex
CREATE INDEX "ClinicalRecord_patientId_type_createdAt_idx" ON "ClinicalRecord"("patientId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "ClinicalRecord_authoredById_status_createdAt_idx" ON "ClinicalRecord"("authoredById", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicalRecord_previousVersionId_version_key" ON "ClinicalRecord"("previousVersionId", "version");

-- CreateIndex
CREATE INDEX "Prescription_patientId_createdAt_idx" ON "Prescription"("patientId", "createdAt");

-- CreateIndex
CREATE INDEX "Prescription_prescribedById_status_createdAt_idx" ON "Prescription"("prescribedById", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PrescriptionItem_prescriptionId_idx" ON "PrescriptionItem"("prescriptionId");

-- CreateIndex
CREATE INDEX "NursingTask_patientId_status_createdAt_idx" ON "NursingTask"("patientId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "NursingTask_assignedToId_status_dueAt_idx" ON "NursingTask"("assignedToId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "NursingHandover_patientId_createdAt_idx" ON "NursingHandover"("patientId", "createdAt");

-- CreateIndex
CREATE INDEX "NursingHandover_receivedById_createdAt_idx" ON "NursingHandover"("receivedById", "createdAt");

-- CreateIndex
CREATE INDEX "MedicationAdministration_patientId_administeredAt_idx" ON "MedicationAdministration"("patientId", "administeredAt");

-- CreateIndex
CREATE INDEX "MedicationAdministration_prescriptionItemId_administeredAt_idx" ON "MedicationAdministration"("prescriptionItemId", "administeredAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyTriageCategory_code_key" ON "EmergencyTriageCategory"("code");

-- CreateIndex
CREATE INDEX "EmergencyTriageCategory_active_priority_idx" ON "EmergencyTriageCategory"("active", "priority");

-- CreateIndex
CREATE INDEX "EmergencyVisit_status_arrivedAt_idx" ON "EmergencyVisit"("status", "arrivedAt");

-- CreateIndex
CREATE INDEX "EmergencyVisit_patientId_arrivedAt_idx" ON "EmergencyVisit"("patientId", "arrivedAt");

-- AddForeignKey
ALTER TABLE "ClinicalFieldDefinition" ADD CONSTRAINT "ClinicalFieldDefinition_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalRecord" ADD CONSTRAINT "ClinicalRecord_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalRecord" ADD CONSTRAINT "ClinicalRecord_authoredById_fkey" FOREIGN KEY ("authoredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalRecord" ADD CONSTRAINT "ClinicalRecord_signedById_fkey" FOREIGN KEY ("signedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalRecord" ADD CONSTRAINT "ClinicalRecord_previousVersionId_fkey" FOREIGN KEY ("previousVersionId") REFERENCES "ClinicalRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalRecord" ADD CONSTRAINT "ClinicalRecord_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalRecord" ADD CONSTRAINT "ClinicalRecord_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "Admission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalRecord" ADD CONSTRAINT "ClinicalRecord_emergencyVisitId_fkey" FOREIGN KEY ("emergencyVisitId") REFERENCES "EmergencyVisit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_clinicalRecordId_fkey" FOREIGN KEY ("clinicalRecordId") REFERENCES "ClinicalRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_prescribedById_fkey" FOREIGN KEY ("prescribedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_signedById_fkey" FOREIGN KEY ("signedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrescriptionItem" ADD CONSTRAINT "PrescriptionItem_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrescriptionItem" ADD CONSTRAINT "PrescriptionItem_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "Medicine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NursingTask" ADD CONSTRAINT "NursingTask_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NursingTask" ADD CONSTRAINT "NursingTask_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "Admission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NursingTask" ADD CONSTRAINT "NursingTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NursingTask" ADD CONSTRAINT "NursingTask_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NursingHandover" ADD CONSTRAINT "NursingHandover_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NursingHandover" ADD CONSTRAINT "NursingHandover_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "Admission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NursingHandover" ADD CONSTRAINT "NursingHandover_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NursingHandover" ADD CONSTRAINT "NursingHandover_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationAdministration" ADD CONSTRAINT "MedicationAdministration_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationAdministration" ADD CONSTRAINT "MedicationAdministration_prescriptionItemId_fkey" FOREIGN KEY ("prescriptionItemId") REFERENCES "PrescriptionItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationAdministration" ADD CONSTRAINT "MedicationAdministration_administeredById_fkey" FOREIGN KEY ("administeredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyTriageCategory" ADD CONSTRAINT "EmergencyTriageCategory_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyVisit" ADD CONSTRAINT "EmergencyVisit_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyVisit" ADD CONSTRAINT "EmergencyVisit_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "Admission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyVisit" ADD CONSTRAINT "EmergencyVisit_triageCategoryId_fkey" FOREIGN KEY ("triageCategoryId") REFERENCES "EmergencyTriageCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyVisit" ADD CONSTRAINT "EmergencyVisit_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyVisit" ADD CONSTRAINT "EmergencyVisit_assignedClinicianId_fkey" FOREIGN KEY ("assignedClinicianId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyVisit" ADD CONSTRAINT "EmergencyVisit_triagedById_fkey" FOREIGN KEY ("triagedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
