import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";

export async function registerHealthRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  redis: Redis
) {
  app.get("/api/health", async (_request, reply) => {
    let database: "ok" | "error" = "ok";
    let queue: "ok" | "error" = "ok";

    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      database = "error";
      app.log.error({ err: error }, "Database health check failed");
    }

    try {
      await redis.ping();
    } catch (error) {
      queue = "error";
      app.log.error({ err: error }, "Queue health check failed");
    }

    const status = database === "ok" && queue === "ok" ? "ok" : "degraded";
    let yougile: "ok" | "not_configured" = "not_configured";
    try {
      const tokenCount = await prisma.portalUser.count({
        where: { active: true, yougileTokenEncrypted: { not: null } }
      });
      if (tokenCount > 0) yougile = "ok";
    } catch (error) {
      app.log.error({ err: error }, "YouGile token health check failed");
    }
    const result = { status, services: { api: "ok", database, queue, yougile } };
    return status === "ok" ? result : reply.code(503).send(result);
  });
}
