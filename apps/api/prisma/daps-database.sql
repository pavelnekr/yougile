-- Run once against the dedicated PostgreSQL database configured for DAPS.
-- This database stores report data only; user ids are audit references without
-- foreign keys to the portal database.
CREATE TYPE "DapsDataset" AS ENUM (
  'AGGREGATE', 'KPI_REPORT', 'STATUS_CHANGES', 'RESPONSIBLE_CHANGES', 'POLITICS', 'POLITICS_WEEKLY'
);

CREATE TABLE "DapsImportBatch" (
  "id" TEXT PRIMARY KEY,
  "fileName" TEXT NOT NULL,
  "dataset" "DapsDataset" NOT NULL,
  "rowCount" INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "DapsReportRow" (
  "id" TEXT PRIMARY KEY,
  "dataset" "DapsDataset" NOT NULL,
  "externalKey" TEXT NOT NULL,
  "reportDate" DATE,
  "data" JSONB NOT NULL,
  "sourceFile" TEXT NOT NULL,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "DapsKpiDay" (
  "date" DATE PRIMARY KEY,
  "values" JSONB NOT NULL,
  "updatedById" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "DapsReportRow_dataset_externalKey_key" ON "DapsReportRow"("dataset", "externalKey");
CREATE INDEX "DapsImportBatch_createdAt_idx" ON "DapsImportBatch"("createdAt");
CREATE INDEX "DapsImportBatch_dataset_createdAt_idx" ON "DapsImportBatch"("dataset", "createdAt");
CREATE INDEX "DapsReportRow_dataset_reportDate_idx" ON "DapsReportRow"("dataset", "reportDate");
