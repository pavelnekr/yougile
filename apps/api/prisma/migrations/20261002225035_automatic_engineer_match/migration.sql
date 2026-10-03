-- AlterEnum
ALTER TYPE "ImportRowStatus" ADD VALUE 'ENGINEER_NOT_FOUND';

-- AlterTable
ALTER TABLE "ImportRow" ADD COLUMN     "engineerUserId" TEXT;
