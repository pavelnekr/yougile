import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { UserYougileCredentialError, getUserYougileClient } from "../../integrations/yougile/user-client.js";
import { loadAvrColumns } from "../portal-config/service.js";
import { getAvrSites, getPlannedSites } from "./service.js";

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

  // Единая таблица площадок АВР: столбцы из «Конфигурация портала» → «АВР»,
  // к каждому столбцу — его площадки. Карточка и страница «Площадки АВР»
  // используют один и тот же ответ, поэтому у них всегда одни и те же числа.
  app.get("/api/sites/in-avr", async (request, reply) => {
    try {
      const yougile = await getUserYougileClient(prisma, request.sessionUser?.id);
      const configured = await loadAvrColumns(prisma);
      const result = await getAvrSites(yougile, configured);
      const items = result.columns.flatMap((column) =>
        column.sites.map((site) => ({ ...site, columnId: column.id, columnName: column.name }))
      );
      return {
        columns: result.columns.map((column) => ({
          id: column.id,
          name: column.name,
          count: column.sites.length
        })),
        items,
        total: result.total,
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      if (error instanceof UserYougileCredentialError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      app.log.error({ err: error }, "Could not load sites from AVR columns");
      return reply.code(502).send({
        error: "Не удалось загрузить площадки из YouGile. Проверьте доступ к столбцам АВР."
      });
    }
  });
}
