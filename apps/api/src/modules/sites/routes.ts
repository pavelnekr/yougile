import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { UserYougileCredentialError, getUserYougileClient } from "../../integrations/yougile/user-client.js";
import { isYougileBusy } from "../../lib/yougile-activity.js";
import { loadAvrColumns } from "../portal-config/service.js";
import { getAvrSites, getPlannedSites, peekAvrSites, peekPlannedSites, type AvrSitesList } from "./service.js";

// Карточке и странице «Площадки АВР» нужен один и тот же ответ: список столбцов
// с их площадками. Разворачиваем его в плоскую таблицу с именем столбца у каждой
// площадки — одинаково и для свежих данных, и для ответа из кэша.
function avrResponse(result: AvrSitesList, paused: boolean) {
  return {
    columns: result.columns.map((column) => ({
      id: column.id,
      name: column.name,
      count: column.sites.length
    })),
    items: result.columns.flatMap((column) =>
      column.sites.map((site) => ({ ...site, columnId: column.id, columnName: column.name }))
    ),
    total: result.total,
    updatedAt: new Date().toISOString(),
    paused
  };
}

export async function registerSiteRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get("/api/sites/in-plan", async (request, reply) => {
    try {
      const yougile = await getUserYougileClient(prisma, request.sessionUser?.id);

      // Пока идёт операция, списки площадок не перечитываются: параллельные
      // запросы к YouGile дают HTTP 429 «Too Many Requests». Отдаём последний
      // кэш (даже просроченный) и помечаем ответ флагом paused — фронтенд
      // покажет пометку и повторит запрос, когда операции закончатся.
      if (await isYougileBusy(prisma)) {
        const cached = peekPlannedSites(yougile);
        return {
          items: cached ?? [],
          count: cached?.length ?? 0,
          updatedAt: new Date().toISOString(),
          paused: true
        };
      }

      const items = await getPlannedSites(yougile);
      return {
        items,
        count: items.length,
        updatedAt: new Date().toISOString(),
        paused: false
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

      // Пока идёт операция — только кэш, без обращения к YouGile (как в in-plan).
      if (await isYougileBusy(prisma)) {
        const cached = peekAvrSites(yougile, configured);
        return avrResponse(
          cached ?? { columns: [], items: [], total: 0 },
          true
        );
      }

      return avrResponse(await getAvrSites(yougile, configured), false);
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
