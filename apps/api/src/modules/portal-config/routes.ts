import type { FastifyInstance } from "fastify";
import { PortalRole, type PrismaClient } from "@prisma/client";
import { requireRole } from "../auth/service.js";
import { invalidateAvrSitesCache, invalidateSitesCache } from "../sites/service.js";
import { avrColumnsSchema, planColumnSchema } from "./schema.js";
import {
  avrColumnsSettingKey,
  getPlanColumn,
  loadAvrColumns,
  loadPlanColumn,
  planColumnSettingKey,
  setPlanColumn
} from "./service.js";

/**
 * Конфигурация портала: ID столбцов YouGile. Раздел доступен только роли ADMIN —
 * операторы не видят его ни в меню, ни через API (проверка в requireRole).
 *
 * Столбец плана («Фильтрация») управляет тем, откуда грузится список площадок,
 * поэтому после сохранения он сразу подставляется в память процесса и сбрасывается
 * кэш площадок. Столбцы АВР пока только хранятся: рабочие процессы их не читают.
 */
export async function registerPortalConfigRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const adminOnly = requireRole(PortalRole.ADMIN);

  // Значение по умолчанию читается из БД один раз при старте, дальше держится в
  // памяти (см. service.ts), чтобы не ходить в базу на каждый запрос площадок.
  await loadPlanColumn(prisma);

  app.get("/api/portal-config/columns", { preHandler: adminOnly }, async (_request, reply) => {
    try {
      const avr = await loadAvrColumns(prisma);
      return { plan: getPlanColumn(), avr };
    } catch (error) {
      app.log.error({ err: error }, "Could not read portal column settings");
      return reply.code(500).send({ error: "Не удалось загрузить конфигурацию столбцов." });
    }
  });

  app.put("/api/portal-config/plan-column", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = planColumnSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте данные столбца." });
    }
    try {
      await prisma.appSetting.upsert({
        where: { key: planColumnSettingKey },
        create: { key: planColumnSettingKey, value: parsed.data },
        update: { value: parsed.data }
      });
    } catch (error) {
      app.log.error({ err: error }, "Could not save plan column setting");
      return reply.code(500).send({ error: "Не удалось сохранить столбец «Фильтрация»." });
    }
    setPlanColumn(parsed.data);
    // Кэш площадок собран из старой колонки — сбрасываем, чтобы новый план
    // подхватился сразу после сохранения, а не через 30 секунд.
    invalidateSitesCache();
    app.log.warn(
      { actor: request.sessionUser?.login, columnId: parsed.data.id },
      "Plan column updated via portal config"
    );
    return { plan: parsed.data };
  });

  app.put("/api/portal-config/avr-columns", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = avrColumnsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте данные столбцов." });
    }
    try {
      await prisma.appSetting.upsert({
        where: { key: avrColumnsSettingKey },
        create: { key: avrColumnsSettingKey, value: parsed.data.items },
        update: { value: parsed.data.items }
      });
    } catch (error) {
      app.log.error({ err: error }, "Could not save AVR columns setting");
      return reply.code(500).send({ error: "Не удалось сохранить столбцы АВР." });
    }
    // Список столбцов изменился — подсчёт площадок по старым ID невалиден,
    // сбрасываем кэш, чтобы карточка «Площадки в АВР» сразу показала новое число.
    invalidateAvrSitesCache();
    app.log.warn(
      { actor: request.sessionUser?.login, count: parsed.data.items.length },
      "AVR columns updated via portal config"
    );
    return { avr: parsed.data.items };
  });
}
