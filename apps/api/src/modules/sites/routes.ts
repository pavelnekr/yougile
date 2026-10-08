import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { UserYougileCredentialError, getUserYougileClient } from "../../integrations/yougile/user-client.js";
import { loadAvrColumns } from "../portal-config/service.js";
import { getAvrSitesCount, getPlannedSites } from "./service.js";

export async function registerSiteRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get("/api/sites/in-plan", async (request, reply) => {
    try {
      const yougile = await getUserYougileClient(prisma, request.sessionUser?.id);
      const items = await getPlannedSites(yougile);
      return {
        items,
        count: items.length,
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      if (error instanceof UserYougileCredentialError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      app.log.error({ err: error }, "Could not load planned sites from YouGile");
      return reply.code(502).send({
        error: "Не удалось загрузить площадки из YouGile. Проверьте доступ к колонке плана."
      });
    }
  });

  // Карточка «Площадки в АВР» на обзоре: суммарное число площадок по столбцам,
  // добавленным администратором в «Конфигурация портала» → «АВР».
  app.get("/api/sites/avr-count", async (request, reply) => {
    try {
      const yougile = await getUserYougileClient(prisma, request.sessionUser?.id);
      const columns = await loadAvrColumns(prisma);
      const result = await getAvrSitesCount(yougile, columns);
      return {
        ...result,
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      if (error instanceof UserYougileCredentialError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      app.log.error({ err: error }, "Could not count sites in AVR columns");
      return reply.code(502).send({
        error: "Не удалось загрузить площадки из YouGile. Проверьте доступ к столбцам АВР."
      });
    }
  });
}
