-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('INFO', 'WARN', 'ERROR');

-- CreateTable
CREATE TABLE "PortalLog" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" "LogLevel" NOT NULL DEFAULT 'INFO',
    "action" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "actorId" TEXT,
    "actorLogin" TEXT,
    "actorRole" TEXT,
    "ip" TEXT,
    "method" TEXT,
    "path" TEXT,
    "status" INTEGER,
    "durationMs" INTEGER,
    "request" JSONB,
    "error" TEXT,
    "entityId" TEXT,

    CONSTRAINT "PortalLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortalLog_createdAt_idx" ON "PortalLog"("createdAt");

-- CreateIndex
CREATE INDEX "PortalLog_level_createdAt_idx" ON "PortalLog"("level", "createdAt");

-- CreateIndex
CREATE INDEX "PortalLog_actorLogin_createdAt_idx" ON "PortalLog"("actorLogin", "createdAt");

-- CreateIndex
CREATE INDEX "PortalLog_action_idx" ON "PortalLog"("action");
