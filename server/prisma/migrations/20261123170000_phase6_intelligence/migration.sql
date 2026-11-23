-- CreateEnum
CREATE TYPE "IntelligenceAlertCategory" AS ENUM ('BED', 'INVENTORY', 'LABORATORY', 'DISCHARGE', 'DEPARTMENT', 'BILLING');

-- CreateEnum
CREATE TYPE "IntelligenceAlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "IntelligenceAlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- AlterTable
ALTER TABLE "QueueEntry" ADD COLUMN     "calledAt" TIMESTAMP(3),
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OperationalAlertRule" (
    "key" TEXT NOT NULL,
    "category" "IntelligenceAlertCategory" NOT NULL,
    "severity" "IntelligenceAlertSeverity" NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalAlertRule_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "OperationalAlert" (
    "id" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "category" "IntelligenceAlertCategory" NOT NULL,
    "severity" "IntelligenceAlertSeverity" NOT NULL,
    "status" "IntelligenceAlertStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "departmentId" TEXT,
    "metricValue" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OperationalAlertRule_category_enabled_idx" ON "OperationalAlertRule"("category", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "OperationalAlert_dedupeKey_key" ON "OperationalAlert"("dedupeKey");

-- CreateIndex
CREATE INDEX "OperationalAlert_category_status_createdAt_idx" ON "OperationalAlert"("category", "status", "createdAt");

-- CreateIndex
CREATE INDEX "OperationalAlert_departmentId_status_createdAt_idx" ON "OperationalAlert"("departmentId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "OperationalAlert_ruleKey_status_idx" ON "OperationalAlert"("ruleKey", "status");

-- CreateIndex
CREATE INDEX "Admission_admittedAt_idx" ON "Admission"("admittedAt");

-- CreateIndex
CREATE INDEX "Admission_dischargedAt_idx" ON "Admission"("dischargedAt");

-- CreateIndex
CREATE INDEX "Appointment_departmentId_startsAt_status_idx" ON "Appointment"("departmentId", "startsAt", "status");

-- CreateIndex
CREATE INDEX "HousekeepingTask_type_status_dueAt_idx" ON "HousekeepingTask"("type", "status", "dueAt");

-- CreateIndex
CREATE INDEX "InventoryTransaction_medicineId_createdAt_idx" ON "InventoryTransaction"("medicineId", "createdAt");

-- CreateIndex
CREATE INDEX "QueueEntry_departmentId_serviceDate_calledAt_idx" ON "QueueEntry"("departmentId", "serviceDate", "calledAt");

-- AddForeignKey
ALTER TABLE "OperationalAlertRule" ADD CONSTRAINT "OperationalAlertRule_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalAlert" ADD CONSTRAINT "OperationalAlert_ruleKey_fkey" FOREIGN KEY ("ruleKey") REFERENCES "OperationalAlertRule"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalAlert" ADD CONSTRAINT "OperationalAlert_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalAlert" ADD CONSTRAINT "OperationalAlert_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalAlert" ADD CONSTRAINT "OperationalAlert_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
