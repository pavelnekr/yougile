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
    // Версия конвертера разметки шаблонов (**слово** → жирный в чате).
    // Поле нужно для диагностики: если в health оно отсутствует или равно 1,
    // работающий API собран со старым кодом и звёздочки из шаблонов уходят
    // в YouGile как обычный текст.
    const commentMarkup = 2;
    const result = { status, services: { api: "ok", database, queue, yougile }, commentMarkup };
    return status === "ok" ? result : reply.code(503).send(result);
  });
}
