ALTER TYPE "PortalWorkspace" ADD VALUE 'DAPS';

CREATE TYPE "DapsDataset" AS ENUM (
  'AGGREGATE',
  'KPI_REPORT',
  'STATUS_CHANGES',
  'RESPONSIBLE_CHANGES',
  'POLITICS',
  'POLITICS_WEEKLY'
);

CREATE TABLE "DapsImportBatch" (
  "id" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "dataset" "DapsDataset" NOT NULL,
  "rowCount" INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DapsImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DapsReportRow" (
  "id" TEXT NOT NULL,
  "dataset" "DapsDataset" NOT NULL,
  "externalKey" TEXT NOT NULL,
  "reportDate" DATE,
  "data" JSONB NOT NULL,
  "sourceFile" TEXT NOT NULL,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DapsReportRow_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DapsKpiDay" (
  "date" DATE NOT NULL,
  "values" JSONB NOT NULL,
  "updatedById" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DapsKpiDay_pkey" PRIMARY KEY ("date")
);

CREATE UNIQUE INDEX "DapsReportRow_dataset_externalKey_key" ON "DapsReportRow"("dataset", "externalKey");
CREATE INDEX "DapsImportBatch_createdAt_idx" ON "DapsImportBatch"("createdAt");
CREATE INDEX "DapsImportBatch_dataset_createdAt_idx" ON "DapsImportBatch"("dataset", "createdAt");
CREATE INDEX "DapsReportRow_dataset_reportDate_idx" ON "DapsReportRow"("dataset", "reportDate");

