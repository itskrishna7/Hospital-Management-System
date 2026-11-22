-- CreateEnum
CREATE TYPE "PortalChallengePurpose" AS ENUM ('PATIENT_REGISTRATION', 'EMAIL_VERIFICATION');

-- CreateEnum
CREATE TYPE "PortalAccessScope" AS ENUM ('APPOINTMENTS', 'JOURNEY', 'LAB_RESULTS', 'BILLING');

-- CreateEnum
CREATE TYPE "QueueEntryStatus" AS ENUM ('WAITING', 'CALLED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "portalUserId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PortalVerificationChallenge" (
    "id" TEXT NOT NULL,
    "purpose" "PortalChallengePurpose" NOT NULL,
    "patientId" TEXT,
    "userId" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "codeHash" TEXT NOT NULL,
    "passwordHash" TEXT,
    "ipAddress" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalVerificationChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientAccessGrant" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "granteeUserId" TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "scopes" "PortalAccessScope"[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FamilyAccessInvitation" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "acceptedById" TEXT,
    "invitedEmail" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" "PortalAccessScope"[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FamilyAccessInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalNotificationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortalNotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalNotification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "destination" TEXT NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueCounter" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "serviceDate" DATE NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QueueCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueEntry" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "departmentId" TEXT NOT NULL,
    "serviceDate" DATE NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "QueueEntryStatus" NOT NULL DEFAULT 'WAITING',
    "checkedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QueueEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentCheckInToken" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "issuedByUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentCheckInToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortalVerificationChallenge_ipAddress_createdAt_idx" ON "PortalVerificationChallenge"("ipAddress", "createdAt");

-- CreateIndex
CREATE INDEX "PortalVerificationChallenge_patientId_purpose_createdAt_idx" ON "PortalVerificationChallenge"("patientId", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "PortalVerificationChallenge_userId_purpose_createdAt_idx" ON "PortalVerificationChallenge"("userId", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "PatientAccessGrant_patientId_granteeUserId_expiresAt_revoke_idx" ON "PatientAccessGrant"("patientId", "granteeUserId", "expiresAt", "revokedAt");

-- CreateIndex
CREATE INDEX "PatientAccessGrant_granteeUserId_expiresAt_revokedAt_idx" ON "PatientAccessGrant"("granteeUserId", "expiresAt", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FamilyAccessInvitation_tokenHash_key" ON "FamilyAccessInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "FamilyAccessInvitation_patientId_expiresAt_acceptedAt_revok_idx" ON "FamilyAccessInvitation"("patientId", "expiresAt", "acceptedAt", "revokedAt");

-- CreateIndex
CREATE INDEX "FamilyAccessInvitation_invitedEmail_expiresAt_acceptedAt_idx" ON "FamilyAccessInvitation"("invitedEmail", "expiresAt", "acceptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PortalNotificationPreference_userId_key" ON "PortalNotificationPreference"("userId");

-- CreateIndex
CREATE INDEX "PortalNotification_userId_readAt_createdAt_idx" ON "PortalNotification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_createdAt_idx" ON "NotificationDelivery"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_notificationId_channel_key" ON "NotificationDelivery"("notificationId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "QueueCounter_departmentId_serviceDate_key" ON "QueueCounter"("departmentId", "serviceDate");

-- CreateIndex
CREATE UNIQUE INDEX "QueueEntry_appointmentId_key" ON "QueueEntry"("appointmentId");

-- CreateIndex
CREATE INDEX "QueueEntry_patientId_serviceDate_status_idx" ON "QueueEntry"("patientId", "serviceDate", "status");

-- CreateIndex
CREATE INDEX "QueueEntry_departmentId_serviceDate_status_sequence_idx" ON "QueueEntry"("departmentId", "serviceDate", "status", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "QueueEntry_departmentId_serviceDate_sequence_key" ON "QueueEntry"("departmentId", "serviceDate", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentCheckInToken_tokenHash_key" ON "AppointmentCheckInToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AppointmentCheckInToken_appointmentId_expiresAt_consumedAt_idx" ON "AppointmentCheckInToken"("appointmentId", "expiresAt", "consumedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_portalUserId_key" ON "Patient"("portalUserId");

-- AddForeignKey
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_portalUserId_fkey" FOREIGN KEY ("portalUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalVerificationChallenge" ADD CONSTRAINT "PortalVerificationChallenge_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalVerificationChallenge" ADD CONSTRAINT "PortalVerificationChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientAccessGrant" ADD CONSTRAINT "PatientAccessGrant_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientAccessGrant" ADD CONSTRAINT "PatientAccessGrant_granteeUserId_fkey" FOREIGN KEY ("granteeUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientAccessGrant" ADD CONSTRAINT "PatientAccessGrant_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyAccessInvitation" ADD CONSTRAINT "FamilyAccessInvitation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyAccessInvitation" ADD CONSTRAINT "FamilyAccessInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyAccessInvitation" ADD CONSTRAINT "FamilyAccessInvitation_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalNotificationPreference" ADD CONSTRAINT "PortalNotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalNotification" ADD CONSTRAINT "PortalNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "PortalNotification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueCounter" ADD CONSTRAINT "QueueCounter_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentCheckInToken" ADD CONSTRAINT "AppointmentCheckInToken_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentCheckInToken" ADD CONSTRAINT "AppointmentCheckInToken_issuedByUserId_fkey" FOREIGN KEY ("issuedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

