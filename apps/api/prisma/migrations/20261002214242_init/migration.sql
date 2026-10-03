-- CreateEnum
CREATE TYPE "PortalRole" AS ENUM ('ADMIN', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "OperationType" AS ENUM ('ASSIGN', 'REMOVE', 'REASSIGN', 'AUDIT', 'USER_SYNC', 'IMPORT');

-- CreateEnum
CREATE TYPE "OperationStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OperationItemStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "PortalUser" (
    "id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "PortalRole" NOT NULL DEFAULT 'OPERATOR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortalUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YougileUser" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YougileUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteTask" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "yougileTaskId" TEXT,
    "yougileUserId" TEXT,
    "address" TEXT,
    "cluster" TEXT,
    "scheduledAt" TEXT,
    "workRequired" TEXT,
    "comment" TEXT,
    "assignedUserIds" JSONB,
    "rawData" JSONB NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Operation" (
    "id" TEXT NOT NULL,
    "type" "OperationType" NOT NULL,
    "status" "OperationStatus" NOT NULL DEFAULT 'QUEUED',
    "createdById" TEXT NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "metadata" JSONB,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationItem" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "siteTaskId" TEXT,
    "siteId" TEXT NOT NULL,
    "status" "OperationItemStatus" NOT NULL DEFAULT 'PENDING',
    "requestedUserId" TEXT,
    "beforeData" JSONB,
    "afterData" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PortalUser_login_key" ON "PortalUser"("login");

-- CreateIndex
CREATE UNIQUE INDEX "SiteTask_siteId_key" ON "SiteTask"("siteId");

-- CreateIndex
CREATE INDEX "SiteTask_yougileTaskId_idx" ON "SiteTask"("yougileTaskId");

-- CreateIndex
CREATE INDEX "SiteTask_yougileUserId_idx" ON "SiteTask"("yougileUserId");

-- CreateIndex
CREATE INDEX "SiteTask_cluster_idx" ON "SiteTask"("cluster");

-- CreateIndex
CREATE INDEX "Operation_createdById_createdAt_idx" ON "Operation"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "Operation_status_createdAt_idx" ON "Operation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OperationItem_operationId_status_idx" ON "OperationItem"("operationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OperationItem_operationId_siteId_key" ON "OperationItem"("operationId", "siteId");

-- CreateIndex
CREATE INDEX "ImportBatch_checksum_idx" ON "ImportBatch"("checksum");

-- CreateIndex
CREATE INDEX "ImportBatch_createdAt_idx" ON "ImportBatch"("createdAt");

-- AddForeignKey
ALTER TABLE "SiteTask" ADD CONSTRAINT "SiteTask_yougileUserId_fkey" FOREIGN KEY ("yougileUserId") REFERENCES "YougileUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "PortalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationItem" ADD CONSTRAINT "OperationItem_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationItem" ADD CONSTRAINT "OperationItem_siteTaskId_fkey" FOREIGN KEY ("siteTaskId") REFERENCES "SiteTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "PortalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
