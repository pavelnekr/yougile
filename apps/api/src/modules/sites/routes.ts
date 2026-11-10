import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { requireWorkspaceAccess } from "../auth/service.js";
import { isYougileBusy } from "../../lib/yougile-activity.js";
import { describeError } from "../../lib/error-details.js";
import { annotateLog } from "../logs/service.js";
import { loadAvrColumns } from "../portal-config/service.js";
import type { AvrSitesList } from "./service.js";
import { getAvrSitesSnapshot, getPlanSitesSnapshot } from "./snapshot.js";

// Карточке и странице «Площадки АВР» нужен один и тот же ответ: список столбцов
// с их площадками. Разворачиваем его в плоскую таблицу с именем столбца у каждой
// площадки — одинаково и для свежих данных, и для ответа из кэша.
function avrResponse(result: AvrSitesList, paused: boolean, updatedAt = new Date().toISOString(), refreshing = false) {
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
    engineerAssignments: result.engineerAssignments,
    updatedAt,
    paused,
    refreshing
  };
}

export async function registerSiteRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const readAccess = requireWorkspaceAccess("WORK_MANAGEMENT");
  app.get("/api/sites/in-plan", { preHandler: readAccess }, async (request, reply) => {
    try {
      const snapshot = await getPlanSitesSnapshot(prisma);
      const paused = await isYougileBusy(prisma);
      return {
        items: snapshot.items,
        count: snapshot.items.length,
        updatedAt: snapshot.updatedAt,
        paused,
        refreshing: snapshot.refreshing
      };
    } catch (error: unknown) {
      annotateLog(request, {
        message: "Не удалось прочитать общий снимок плана",
        details: { error: describeError(error) }
      });
      app.log.error({ err: error }, "Could not read shared planned sites snapshot");
      return reply.code(502).send({
        error: "Не удалось загрузить общий список площадок из базы данных."
      });
    }
  });

  // Единая таблица площадок АВР: столбцы из «Конфигурация портала» → «АВР»,
  // к каждому столбцу — его площадки. Карточка и страница «Площадки АВР»
  // используют один и тот же ответ, поэтому у них всегда одни и те же числа.
  app.get("/api/sites/in-avr", { preHandler: readAccess }, async (_request, reply) => {
    try {
      const configured = await loadAvrColumns(prisma);
      const snapshot = await getAvrSitesSnapshot(prisma, configured);
      return avrResponse(snapshot.data, await isYougileBusy(prisma), snapshot.updatedAt, snapshot.refreshing);
    } catch (error) {
      app.log.error({ err: error }, "Could not load sites from AVR columns");
      return reply.code(502).send({
        error: "Не удалось загрузить площадки из YouGile. Проверьте доступ к столбцам АВР."
      });
    }
  });
}
