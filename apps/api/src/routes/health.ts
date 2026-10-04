import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { config } from "../config.js";

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
    // Отдельно сообщаем, задан ли токен YouGile. Без него клиент вообще не
    // ходит в сеть (см. YougileClient), и пять экранов портала падают с
    // сообщением про колонку плана, хотя колонка тут ни при чём. Статус не
    // влияет на код ответа: база и очередь живы, это состояние настройки, а не
    // авария, поэтому 503 не ставим.
    const yougile = config.YOUGILE_API_TOKEN ? "ok" : "not_configured";
    const result = { status, services: { api: "ok", database, queue, yougile } };
    return status === "ok" ? result : reply.code(503).send(result);
  });
}
