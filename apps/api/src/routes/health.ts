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
    const result = { status, services: { api: "ok", database, queue } };
    return status === "ok" ? result : reply.code(503).send(result);
  });
}
