-- CreateTable
CREATE TABLE "PlanRow" (
    "id" TEXT NOT NULL,
    "planDate" DATE,
    "shift" TEXT,
    "timeWindow" TEXT,
    "siteId" TEXT,
    "address" TEXT,
    "po" TEXT,
    "comment" TEXT,
    "engineer" TEXT,
    "comment2" TEXT,
    "status" TEXT,
    "cluster" TEXT,
    "free1" TEXT,
    "free2" TEXT,
    "free3" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlanRow_planDate_idx" ON "PlanRow"("planDate");

-- CreateIndex
CREATE INDEX "PlanRow_siteId_idx" ON "PlanRow"("siteId");

-- CreateIndex
CREATE INDEX "PlanRow_engineer_idx" ON "PlanRow"("engineer");

-- CreateIndex
CREATE INDEX "PlanRow_status_idx" ON "PlanRow"("status");

-- CreateIndex
CREATE INDEX "PlanRow_cluster_idx" ON "PlanRow"("cluster");

-- CreateIndex
CREATE INDEX "PlanRow_sortOrder_idx" ON "PlanRow"("sortOrder");

-- AddForeignKey
ALTER TABLE "PlanRow" ADD CONSTRAINT "PlanRow_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "PortalUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
