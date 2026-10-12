-- CreateEnum
CREATE TYPE "PortalWorkspace" AS ENUM ('WORK_MANAGEMENT', 'COORDINATION', 'WORK_PLANNING');

-- CreateTable
CREATE TABLE "PortalUserWorkspace" (
    "userId" TEXT NOT NULL,
    "workspace" "PortalWorkspace" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalUserWorkspace_pkey" PRIMARY KEY ("userId","workspace")
);

-- CreateIndex
CREATE INDEX "PortalUserWorkspace_workspace_idx" ON "PortalUserWorkspace"("workspace");

-- AddForeignKey
ALTER TABLE "PortalUserWorkspace" ADD CONSTRAINT "PortalUserWorkspace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "PortalUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve current access for accounts created before per-section permissions.
-- New accounts start with no section grants and must be assigned by an admin.
INSERT INTO "PortalUserWorkspace" ("userId", "workspace")
SELECT "id", workspace::"PortalWorkspace"
FROM "PortalUser"
CROSS JOIN unnest(ARRAY['WORK_MANAGEMENT', 'COORDINATION', 'WORK_PLANNING']) AS workspace
WHERE "role" <> 'ADMIN';
