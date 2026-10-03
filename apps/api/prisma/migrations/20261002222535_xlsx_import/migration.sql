-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PREVIEW', 'ASSIGNING', 'COMPLETE');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('READY', 'SITE_NOT_FOUND', 'INVALID_ROW', 'DUPLICATE_SITE');

-- DropForeignKey
ALTER TABLE "ImportBatch" DROP CONSTRAINT "ImportBatch_createdById_fkey";

-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN     "status" "ImportBatchStatus" NOT NULL DEFAULT 'PREVIEW',
ALTER COLUMN "createdById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "OperationItem" ADD COLUMN     "importRowId" TEXT;

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "siteId" TEXT,
    "address" TEXT,
    "engineerName" TEXT,
    "yougileTaskId" TEXT,
    "status" "ImportRowStatus" NOT NULL,
    "rawData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportRow_importBatchId_status_idx" ON "ImportRow"("importBatchId", "status");

-- CreateIndex
CREATE INDEX "ImportRow_siteId_idx" ON "ImportRow"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRow_importBatchId_rowNumber_key" ON "ImportRow"("importBatchId", "rowNumber");

-- AddForeignKey
ALTER TABLE "OperationItem" ADD CONSTRAINT "OperationItem_importRowId_fkey" FOREIGN KEY ("importRowId") REFERENCES "ImportRow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "PortalUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
