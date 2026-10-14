CREATE TABLE "PlanningWork" (
    "id" TEXT NOT NULL,
    "free1" TEXT,
    "data" DATE,
    "day" VARCHAR(40),
    "time" VARCHAR(20),
    "id_site" VARCHAR(100) NOT NULL,
    "address" TEXT,
    "PO" VARCHAR(255),
    "comment" TEXT,
    "free2" TEXT,
    "free3" TEXT,
    "user" VARCHAR(255),
    "comment2" TEXT,
    "status" VARCHAR(100),
    "klaster" VARCHAR(255),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlanningWork_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlanningWork_workDate_createdAt_idx" ON "PlanningWork"("data", "createdAt");
CREATE INDEX "PlanningWork_siteId_idx" ON "PlanningWork"("id_site");
CREATE INDEX "PlanningWork_status_idx" ON "PlanningWork"("status");
CREATE INDEX "PlanningWork_cluster_idx" ON "PlanningWork"("klaster");
CREATE INDEX "PlanningWork_assignee_idx" ON "PlanningWork"("user");
CREATE INDEX "PlanningWork_po_idx" ON "PlanningWork"("PO");

ALTER TABLE "PlanningWork" ADD CONSTRAINT "PlanningWork_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "PortalUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
