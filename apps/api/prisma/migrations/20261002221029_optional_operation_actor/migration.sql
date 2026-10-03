-- DropForeignKey
ALTER TABLE "Operation" DROP CONSTRAINT "Operation_createdById_fkey";

-- AlterTable
ALTER TABLE "Operation" ALTER COLUMN "createdById" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "PortalUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
