import type { FastifyInstance, FastifyReply } from "fastify";
import { PortalRole, type PrismaClient } from "@prisma/client";
import { requireRole } from "../auth/service.js";
import { getUserYougileClient, UserYougileCredentialError } from "../../integrations/yougile/user-client.js";
import type { YougileClient } from "../../integrations/yougile/client.js";
import { invalidateAvrSitesCache, invalidateSitesCache } from "../sites/service.js";
import { avrColumnsSchema, planColumnSchema } from "./schema.js";
import { decryptDapsDatabaseUrl, encryptDapsDatabaseUrl } from "../../integrations/yougile/token-crypto.js";
import {
  defaultDapsAggregateSchema,
  defaultDapsSourceSchema,
  dapsDatabaseSettingKey,
  resetDapsDatabaseClient
} from "../daps/database.js";
import { PrismaClient as DapsPrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  avrColumnsSettingKey,
  checkColumnInYougile,
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
 *
 * ID столбцов проверяются против YouGile и при сохранении, и по запросу статуса:
 * битый ID не должен молча сохраниться и сломать чтение площадок позже.
 */
export async function registerPortalConfigRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const adminOnly = requireRole(PortalRole.ADMIN);
  const postgresSchema = z.string().trim().min(1).max(63).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Имя схемы: латинские буквы, цифры и _; первый символ — буква или _.");

  app.get("/api/portal-config/daps-database", { preHandler: adminOnly }, async () => {
    const setting = await prisma.appSetting.findUnique({ where: { key: dapsDatabaseSettingKey } });
    const value = setting?.value && typeof setting.value === "object" && !Array.isArray(setting.value)
      ? setting.value as Record<string, unknown> : {};
    return {
      configured: typeof value.encryptedUrl === "string" && value.encryptedUrl.length > 0,
      sourceSchema: typeof value.sourceSchema === "string" ? value.sourceSchema : defaultDapsSourceSchema,
      aggregateSchema: typeof value.aggregateSchema === "string" ? value.aggregateSchema : defaultDapsAggregateSchema
    };
  });

  app.put("/api/portal-config/daps-database", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = z.object({
      url: z.string().trim().max(2000).optional(),
      sourceSchema: postgresSchema.default(defaultDapsSourceSchema),
      aggregateSchema: postgresSchema.default(defaultDapsAggregateSchema)
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте параметры PostgreSQL для DAPS." });
    const currentSetting = await prisma.appSetting.findUnique({ where: { key: dapsDatabaseSettingKey } });
    const currentValue = currentSetting?.value && typeof currentSetting.value === "object" && !Array.isArray(currentSetting.value)
      ? currentSetting.value as Record<string, unknown> : {};
    const currentEncryptedUrl = typeof currentValue.encryptedUrl === "string" ? currentValue.encryptedUrl : "";
    if (!parsed.data.url && !currentEncryptedUrl) {
      return reply.code(400).send({ error: "Укажите строку подключения PostgreSQL для DAPS." });
    }
    const connectionUrl = parsed.data.url || decryptDapsDatabaseUrl(currentEncryptedUrl);
    let url: URL;
    try { url = new URL(connectionUrl); } catch { return reply.code(400).send({ error: "Проверьте строку подключения PostgreSQL." }); }
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      return reply.code(400).send({ error: "Поддерживаются только подключения PostgreSQL." });
    }
    const check = new DapsPrismaClient({ datasources: { db: { url: connectionUrl } } });
    try {
      await check.$queryRaw`SELECT 1`;
      const sourceTable = `"${parsed.data.sourceSchema}"."all_k"`;
      const aggregateTable = `"${parsed.data.aggregateSchema}"."Aggregate_for_KPI"`;
      const tables = await check.$queryRaw<Array<{ source: string | null; aggregate: string | null }>>`
        SELECT to_regclass(${sourceTable})::text AS source,
               to_regclass(${aggregateTable})::text AS aggregate
      `;
      if (!tables[0]?.source || !tables[0]?.aggregate) {
        const missing = [
          !tables[0]?.source ? `${parsed.data.sourceSchema}.all_k` : null,
          !tables[0]?.aggregate ? `${parsed.data.aggregateSchema}.Aggregate_for_KPI` : null
        ].filter(Boolean).join(" и ");
        return reply.code(400).send({ error: `Подключение работает, но не найдена таблица ${missing}. Проверьте имена схем и таблиц для отчёта KPI.` });
      }
    } catch (error) {
      app.log.warn({ actor: request.sessionUser?.login }, "DAPS PostgreSQL connection check failed");
      return reply.code(400).send({ error: "Не удалось подключиться к PostgreSQL. Проверьте адрес, базу, логин, пароль и доступ API-сервера." });
    } finally {
      await check.$disconnect();
    }
    try {
      const encryptedUrl = parsed.data.url ? encryptDapsDatabaseUrl(connectionUrl) : currentEncryptedUrl;
      await prisma.appSetting.upsert({
        where: { key: dapsDatabaseSettingKey },
        create: { key: dapsDatabaseSettingKey, value: { encryptedUrl, sourceSchema: parsed.data.sourceSchema, aggregateSchema: parsed.data.aggregateSchema } },
        update: { value: { encryptedUrl, sourceSchema: parsed.data.sourceSchema, aggregateSchema: parsed.data.aggregateSchema } }
      });
      await resetDapsDatabaseClient();
      return { configured: true };
    } catch (error) {
      app.log.error({ err: error, actor: request.sessionUser?.login }, "Could not save DAPS PostgreSQL settings");
      return reply.code(500).send({ error: "Не удалось сохранить настройки DAPS PostgreSQL." });
    }
  });

  // Значение по умолчанию читается из БД один раз при старте, дальше держится в
  // памяти (см. service.ts), чтобы не ходить в базу на каждый запрос площадок.
  await loadPlanColumn(prisma);

  // YouGile-клиент запрашивающего пользователя. Если токен не настроен или
  // повреждён, отвечаем подходящим кодом и сигнализируем «дальше не идём» null.
  async function buildYougileClient(
    reply: FastifyReply,
    userId: string | undefined
  ): Promise<YougileClient | null> {
    try {
      return await getUserYougileClient(prisma, userId);
    } catch (error) {
      if (error instanceof UserYougileCredentialError) {
        await reply.code(error.statusCode).send({ error: error.message });
        return null;
      }
      throw error;
    }
  }

  app.get("/api/portal-config/columns", { preHandler: adminOnly }, async (_request, reply) => {
    try {
      const avr = await loadAvrColumns(prisma);
      return { plan: getPlanColumn(), avr };
    } catch (error) {
      app.log.error({ err: error }, "Could not read portal column settings");
      return reply.code(500).send({ error: "Не удалось загрузить конфигурацию столбцов." });
    }
  });

  // Статус колонки YouGile по ID: существует ли она и доступна ли токену. Служит
  // бейджу «Подключён / ошибка» рядом с полем ID в разделе конфигурации.
  app.get("/api/portal-config/column-status", { preHandler: adminOnly }, async (request, reply) => {
    const rawId = (request.query as { id?: unknown }).id;
    const parsed = planColumnSchema.shape.id.safeParse(typeof rawId === "string" ? rawId.trim() : "");
    if (!parsed.success) {
      return reply.code(400).send({ error: "ID столбца должен быть в формате UUID." });
    }
    const client = await buildYougileClient(reply, request.sessionUser?.id);
    if (!client) return;
    const result = await checkColumnInYougile(client, parsed.data);
    if (result.status === "error") {
      app.log.warn({ columnId: parsed.data, reason: result.reason }, "Column status check failed");
    }
    const message =
      result.status === "ok" ? "Столбец подключён"
        : result.status === "not_found" ? "Не найден в YouGile"
          : result.reason;
    return { id: parsed.data, status: result.status, message };
  });

  app.put("/api/portal-config/plan-column", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = planColumnSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте данные столбца." });
    }
    // Сохранённый неверный ID молча ломал бы список «Площадки» при каждом чтении,
    // поэтому перед записью проверяем, что столбец существует в YouGile.
    const client = await buildYougileClient(reply, request.sessionUser?.id);
    if (!client) return;
    const checked = await checkColumnInYougile(client, parsed.data.id);
    if (checked.status !== "ok") {
      app.log.warn(
        {
          actor: request.sessionUser?.login,
          columnId: parsed.data.id,
          status: checked.status,
          ...(checked.status === "error" ? { reason: checked.reason } : {})
        },
        "Plan column rejected: not available in YouGile"
      );
      return reply.code(400).send({
        error: checked.status === "not_found"
          ? `Столбец «${parsed.data.name}» не найден в YouGile. Проверьте ID.`
          : `Не удалось проверить столбец «${parsed.data.name}» в YouGile: ${checked.reason}.`
      });
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
    // Один битый ID после сохранения рушил бы всю таблицу «Площадки АВР» при
    // чтении, поэтому каждый столбец проверяется против YouGile до записи.
    const client = await buildYougileClient(reply, request.sessionUser?.id);
    if (!client) return;
    const failures: string[] = [];
    for (const column of parsed.data.items) {
      const checked = await checkColumnInYougile(client, column.id);
      if (checked.status !== "ok") {
        const reason = checked.status === "not_found"
          ? "не найден в YouGile"
          : `не удалось проверить в YouGile: ${checked.reason}`;
        failures.push(`Столбец «${column.name}» (ID ${column.id}) ${reason}.`);
        app.log.warn(
          {
            actor: request.sessionUser?.login,
            columnId: column.id,
            status: checked.status,
            ...(checked.status === "error" ? { reason: checked.reason } : {})
          },
          "AVR column rejected when saving: not available in YouGile"
        );
      }
    }
    if (failures.length > 0) {
      return reply.code(400).send({ error: `Не сохраняем: ${failures.join(" ")}` });
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
