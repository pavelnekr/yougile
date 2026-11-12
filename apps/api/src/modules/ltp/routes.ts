import type { FastifyInstance } from "fastify";
import { Prisma, type PortalWorkspace, type PrismaClient } from "@prisma/client";
import { createHmac } from "node:crypto";
import ExcelJS from "exceljs";
import { z } from "zod";
import { config } from "../../config.js";
import { decryptMetabaseSecret } from "../../integrations/yougile/token-crypto.js";
import { requireWorkspaceAccess } from "../auth/service.js";
import { getDapsDatabase } from "../daps/database.js";

const columns = ["siteCode", "eventTs", "filterIp", "localIp", "localPort", "remoteIp", "remotePort", "objectId", "behaviour", "type", "protocol", "extractedSNI"] as const;
const rowSchema = z.object(Object.fromEntries(columns.map((key) => [key, z.string().max(4000)])) as Record<typeof columns[number], z.ZodString>);
type BlockRow = z.infer<typeof rowSchema>;

function parseCsvLine(line: string) {
  const result: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (char === '"' && quoted && line[i + 1] === '"') { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { result.push(cell.trim()); cell = ""; }
    else cell += char;
  }
  result.push(cell.trim());
  return result;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("В CSV нет строк с данными.");
  const headers = parseCsvLine(lines[0]!).map((value) => value.replace(/^"|"$/g, ""));
  if (!headers.includes("protocol") || !headers.includes("extractedSNI")) throw new Error("В CSV не найдены столбцы protocol и extractedSNI.");
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, (values[index] ?? "").replace(/\\/g, "")]));
  });
}

export async function registerLtpRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const readAccess = requireWorkspaceAccess("LTP" as PortalWorkspace);
  const writeAccess = requireWorkspaceAccess("LTP" as PortalWorkspace, true);
  const database = () => getDapsDatabase(prisma);

  app.get("/api/ltp/shift-report/supervisors", { preHandler: readAccess }, async (request, reply) => {
    try {
      const db = await database();
      const rows = await db.$queryRaw<{ name: string }[]>(Prisma.sql`
        SELECT DISTINCT supervising_department AS name
        FROM public."Team Mapping"
        WHERE position = 'Старший_смены'
          AND NULLIF(BTRIM(supervising_department), '') IS NOT NULL
        ORDER BY name
      `);
      return { supervisors: rows.map((row) => row.name) };
    } catch (error) {
      request.log.error({ err: error }, "Could not load LTP shift supervisors");
      return reply.code(503).send({ error: "Не удалось загрузить список старших смены из PostgreSQL DAPS." });
    }
  });

  app.get<{ Querystring: { date?: string } }>("/api/ltp/shift-report", { preHandler: readAccess }, async (request, reply) => {
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    }).safeParse(request.query.date);
    if (!date.success) return reply.code(400).send({ error: "Укажите корректную дату." });

    try {
      const db = await database();
      const rows = await db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT shift_num, fio, tap_all, tap_influence, tap_control,
          szr_all, szr_compl, szr_not_compl, asbi_all, asbi_p1, asbi_p2,
          asbi_drop_traffic_all, asbi_drop_traffic_compl, asbi_not_compl_p1_p2,
          naumen_long_tt, events, politics, bz, errors
        FROM ltp_1.shift_report
        WHERE date::date = ${date.data}::date
        LIMIT 1
      `);
      const errorRows = await db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT tt, type, situation, error, correct_solution, is_in_bz, action
        FROM ltp_1.errors_8
        WHERE date = ${date.data}::date
        ORDER BY id
      `);
      const tapRows = await db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT TO_CHAR(event_date, 'YYYY-MM-DD') AS event_date, area, device, alert, tt, control, actions
        FROM ltp_1.tap_1
        WHERE date = ${date.data}::date
        ORDER BY id
      `);
      const szrRows = await db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT alert_time, resource, TO_CHAR(notification_time, 'HH24:MI') AS notification_time,
          notification, management_call, TO_CHAR(processing_time, 'HH24:MI') AS processing_time, reason
        FROM ltp_1.szr_2
        WHERE date = ${date.data}::date
        ORDER BY id
      `);
      const asbiRows = await db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT tt, priority, description, status, responsible_unit
        FROM ltp_1.asbi_3
        WHERE date = ${date.data}::date
        ORDER BY id
      `);
      const naumenRows = await db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT tt, responsible, time_in_work, reason, last_action, next_action
        FROM ltp_1.naumen_4
        WHERE date = ${date.data}::date
        ORDER BY id
      `);
      const importantEventRows = await db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT event_time, event_name, what_happened, todo_control, deadline, tt_link
        FROM ltp_1.events_5
        WHERE date = ${date.data}::date
        ORDER BY id
      `);
      const row = rows[0];
      if (!row && !errorRows.length && !tapRows.length && !szrRows.length && !asbiRows.length && !naumenRows.length && !importantEventRows.length) return { found: false };
      const numeric = (value: unknown) => {
        const parsed = Number(value ?? 0);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      return {
        found: true,
        shiftNumber: String(row?.shift_num ?? "1"),
        supervisor: String(row?.fio ?? ""),
        metrics: {
          tapAll: row ? numeric(row.tap_all) : tapRows.length, tapInfluence: numeric(row?.tap_influence), tapControl: numeric(row?.tap_control),
          szrAll: numeric(row?.szr_all), szrCompl: numeric(row?.szr_compl), szrNotCompl: row ? numeric(row.szr_not_compl) : szrRows.length,
          asbiAll: row ? numeric(row.asbi_all) : asbiRows.length, asbiP1: numeric(row?.asbi_p1), asbiP2: numeric(row?.asbi_p2),
          asbiDropTrafficAll: numeric(row?.asbi_drop_traffic_all), asbiDropTrafficCompl: numeric(row?.asbi_drop_traffic_compl),
          asbiNotComplP1P2: row ? numeric(row.asbi_not_compl_p1_p2) : asbiRows.length, naumenLongTt: row ? numeric(row.naumen_long_tt) : naumenRows.length,
          events: row ? numeric(row.events) : importantEventRows.length, politics: numeric(row?.politics), bz: numeric(row?.bz), errors: errorRows.length || numeric(row?.errors)
        },
        errorRows: errorRows.map((entry) => ({
          tt: String(entry.tt ?? ""),
          type: String(entry.type ?? ""),
          situation: String(entry.situation ?? ""),
          question: String(entry.error ?? ""),
          solution: String(entry.correct_solution ?? ""),
          inBz: String(entry.is_in_bz ?? "Нет"),
          action: String(entry.action ?? "")
        })),
        tapRows: tapRows.map((entry) => ({
          eventDate: String(entry.event_date ?? ""),
          area: String(entry.area ?? ""),
          device: String(entry.device ?? ""),
          alert: String(entry.alert ?? ""),
          tt: String(entry.tt ?? ""),
          control: String(entry.control ?? ""),
          actions: String(entry.actions ?? "")
        })),
        szrRows: szrRows.map((entry) => ({
          alertTime: String(entry.alert_time ?? ""),
          resource: String(entry.resource ?? ""),
          notifyTime: String(entry.notification_time ?? ""),
          notification: String(entry.notification ?? "Да"),
          managementCall: String(entry.management_call ?? "Да"),
          processTime: String(entry.processing_time ?? ""),
          reason: String(entry.reason ?? "")
        })),
        asbiRows: asbiRows.map((entry) => ({
          tt: String(entry.tt ?? ""),
          priority: String(entry.priority ?? ""),
          description: String(entry.description ?? ""),
          status: String(entry.status ?? ""),
          responsibleUnit: String(entry.responsible_unit ?? "")
        })),
        naumenRows: naumenRows.map((entry) => ({
          tt: String(entry.tt ?? ""),
          responsible: String(entry.responsible ?? ""),
          timeInWork: String(entry.time_in_work ?? ""),
          reason: String(entry.reason ?? ""),
          lastAction: String(entry.last_action ?? ""),
          nextAction: String(entry.next_action ?? "")
        })),
        importantEventRows: importantEventRows.map((entry) => ({
          eventTime: String(entry.event_time ?? ""),
          eventName: String(entry.event_name ?? ""),
          whatHappened: String(entry.what_happened ?? ""),
          todoControl: String(entry.todo_control ?? ""),
          deadline: String(entry.deadline ?? ""),
          ttLink: String(entry.tt_link ?? "")
        }))
      };
    } catch (error) {
      request.log.error({ err: error }, "Could not load LTP shift report");
      return reply.code(503).send({ error: "Не удалось загрузить сводку из PostgreSQL DAPS." });
    }
  });

  app.post<{ Body: unknown }>("/api/ltp/shift-report", { preHandler: writeAccess }, async (request, reply) => {
    const count = z.number().int().min(0).max(1_000_000);
    const parsed = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
        const parsed = new Date(`${value}T00:00:00.000Z`);
        return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
      }, "Укажите корректную дату смены."),
      shiftNumber: z.enum(["1", "2", "3", "4"]),
      supervisor: z.string().trim().min(1).max(200),
      tapAll: count,
      tapInfluence: count,
      tapControl: count,
      szrAll: count,
      szrCompl: count,
      szrNotCompl: count,
      asbiAll: count,
      asbiP1: count,
      asbiP2: count,
      asbiDropTrafficAll: count,
      asbiDropTrafficCompl: count,
      asbiNotComplP1P2: count,
      naumenLongTt: count,
      events: count,
      politics: count,
      bz: count,
      errors: count,
      errorRows: z.array(z.object({
        tt: z.string().trim().max(55),
        type: z.string().trim().max(150),
        situation: z.string().max(10000),
        question: z.string().max(10000),
        solution: z.string().max(10000),
        inBz: z.enum(["Да", "Нет"]),
        action: z.string().max(10000)
      })).max(500).default([]),
      tapRows: z.array(z.object({
        eventDate: z.string().max(10).refine((value) => {
          if (!value) return true;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
          const parsed = new Date(`${value}T00:00:00.000Z`);
          return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
        }),
        area: z.string().trim().max(55),
        device: z.string().trim().max(55),
        alert: z.string().max(10000),
        tt: z.string().trim().max(55),
        control: z.string().max(10000),
        actions: z.string().max(10000)
      })).max(500).default([]),
      szrRows: z.array(z.object({
        alertTime: z.string().max(55),
        resource: z.string().trim().max(255),
        notifyTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).or(z.literal("")),
        notification: z.enum(["Да", "Нет"]),
        managementCall: z.enum(["Да", "Нет"]),
        processTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).or(z.literal("")),
        reason: z.string().max(10000)
      })).max(500).default([]),
      asbiRows: z.array(z.object({
        tt: z.string().trim().max(55),
        priority: z.string().trim().max(55),
        description: z.string().max(10000),
        status: z.string().max(10000),
        responsibleUnit: z.string().max(10000)
      })).max(500).default([]),
      naumenRows: z.array(z.object({
        tt: z.string().trim().max(55),
        responsible: z.string().trim().max(255),
        timeInWork: z.string().max(55),
        reason: z.string().max(10000),
        lastAction: z.string().max(10000),
        nextAction: z.string().max(10000)
      })).max(500).default([]),
      importantEventRows: z.array(z.object({
        eventTime: z.string().max(55),
        eventName: z.string().trim().max(255),
        whatHappened: z.string().max(10000),
        todoControl: z.string().max(10000),
        deadline: z.string().max(255),
        ttLink: z.string().max(10000)
      })).max(500).default([])
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте данные передачи смены." });

    const data = parsed.data;
    try {
      const db = await database();
      await db.$transaction(async (tx) => {
        // The destination table has no ID default or sequence, so serialize
        // portal writes while assigning explicit IDs.
        await tx.$executeRaw`DO $lock$ BEGIN PERFORM pg_advisory_xact_lock(832114750, 1); END $lock$`;
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO ltp_1.shift_report (
          date, shift_num, fio, tap_all, tap_influence, tap_control,
          szr_all, szr_compl, szr_not_compl, asbi_all, asbi_p1, asbi_p2,
          asbi_drop_traffic_all, asbi_drop_traffic_compl, asbi_not_compl_p1_p2,
          naumen_long_tt, events, politics, bz, errors
          ) VALUES (
          ${data.date}::date, ${data.shiftNumber}, ${data.supervisor},
          ${data.tapAll}, ${data.tapInfluence}, ${data.tapControl},
          ${data.szrAll}, ${data.szrCompl}, ${data.szrNotCompl},
          ${data.asbiAll}, ${data.asbiP1}, ${data.asbiP2},
          ${data.asbiDropTrafficAll}, ${data.asbiDropTrafficCompl}, ${data.asbiNotComplP1P2},
          ${data.naumenLongTt}, ${String(data.events)}, ${String(data.politics)}, ${String(data.bz)}, ${String(data.errorRows.length || data.errors)}
          )
          ON CONFLICT (date) DO UPDATE SET
          shift_num = EXCLUDED.shift_num,
          fio = EXCLUDED.fio,
          tap_all = EXCLUDED.tap_all,
          tap_influence = EXCLUDED.tap_influence,
          tap_control = EXCLUDED.tap_control,
          szr_all = EXCLUDED.szr_all,
          szr_compl = EXCLUDED.szr_compl,
          szr_not_compl = EXCLUDED.szr_not_compl,
          asbi_all = EXCLUDED.asbi_all,
          asbi_p1 = EXCLUDED.asbi_p1,
          asbi_p2 = EXCLUDED.asbi_p2,
          asbi_drop_traffic_all = EXCLUDED.asbi_drop_traffic_all,
          asbi_drop_traffic_compl = EXCLUDED.asbi_drop_traffic_compl,
          asbi_not_compl_p1_p2 = EXCLUDED.asbi_not_compl_p1_p2,
          naumen_long_tt = EXCLUDED.naumen_long_tt,
          events = EXCLUDED.events,
          politics = EXCLUDED.politics,
          bz = EXCLUDED.bz,
            errors = EXCLUDED.errors
        `);

        await tx.$executeRaw(Prisma.sql`DELETE FROM ltp_1.errors_8 WHERE date = ${data.date}::date`);
        if (data.errorRows.length) {
          const idRows = await tx.$queryRaw<{ next_id: bigint }[]>(Prisma.sql`
            SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM ltp_1.errors_8
          `);
          let nextId = idRows[0]?.next_id ?? 1n;
          for (const row of data.errorRows) {
            await tx.$executeRaw(Prisma.sql`
              INSERT INTO ltp_1.errors_8 (id, date, tt, type, situation, error, correct_solution, is_in_bz, action)
              VALUES (
                ${nextId}, ${data.date}::date, ${row.tt || null}, ${row.type || null},
                ${row.situation || null}, ${row.question || null}, ${row.solution || null},
                ${row.inBz}, ${row.action || null}
              )
            `);
            nextId += 1n;
          }
        }

        await tx.$executeRaw(Prisma.sql`DELETE FROM ltp_1.tap_1 WHERE date = ${data.date}::date`);
        if (data.tapRows.length) {
          const idRows = await tx.$queryRaw<{ next_id: bigint }[]>(Prisma.sql`
            SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM ltp_1.tap_1
          `);
          let nextId = idRows[0]?.next_id ?? 1n;
          for (const row of data.tapRows) {
            await tx.$executeRaw(Prisma.sql`
              INSERT INTO ltp_1.tap_1 (id, date, event_date, area, device, alert, tt, control, actions)
              VALUES (
                ${nextId}, ${data.date}::date, ${row.eventDate || null}::date,
                ${row.area || null}, ${row.device || null}, ${row.alert || null}, ${row.tt || null},
                ${row.control || null}, ${row.actions || null}
              )
            `);
            nextId += 1n;
          }
        }

        await tx.$executeRaw(Prisma.sql`DELETE FROM ltp_1.szr_2 WHERE date = ${data.date}::date`);
        if (data.szrRows.length) {
          const idRows = await tx.$queryRaw<{ next_id: bigint }[]>(Prisma.sql`
            SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM ltp_1.szr_2
          `);
          let nextId = idRows[0]?.next_id ?? 1n;
          for (const row of data.szrRows) {
            await tx.$executeRaw(Prisma.sql`
              INSERT INTO ltp_1.szr_2 (id, date, alert_time, resource, notification_time, notification, management_call, processing_time, reason)
              VALUES (
                ${nextId}, ${data.date}::date, ${row.alertTime || null}, ${row.resource || null},
                ${row.notifyTime || null}::time, ${row.notification}, ${row.managementCall},
                ${row.processTime || null}::time, ${row.reason || null}
              )
            `);
            nextId += 1n;
          }
        }

        await tx.$executeRaw(Prisma.sql`DELETE FROM ltp_1.asbi_3 WHERE date = ${data.date}::date`);
        if (data.asbiRows.length) {
          const idRows = await tx.$queryRaw<{ next_id: bigint }[]>(Prisma.sql`
            SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM ltp_1.asbi_3
          `);
          let nextId = idRows[0]?.next_id ?? 1n;
          for (const row of data.asbiRows) {
            await tx.$executeRaw(Prisma.sql`
              INSERT INTO ltp_1.asbi_3 (id, date, tt, priority, description, status, responsible_unit)
              VALUES (
                ${nextId}, ${data.date}::date, ${row.tt || null}, ${row.priority || null},
                ${row.description || null}, ${row.status || null}, ${row.responsibleUnit || null}
              )
            `);
            nextId += 1n;
          }
        }

        await tx.$executeRaw(Prisma.sql`DELETE FROM ltp_1.naumen_4 WHERE date = ${data.date}::date`);
        if (data.naumenRows.length) {
          const idRows = await tx.$queryRaw<{ next_id: bigint }[]>(Prisma.sql`
            SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM ltp_1.naumen_4
          `);
          let nextId = idRows[0]?.next_id ?? 1n;
          for (const row of data.naumenRows) {
            await tx.$executeRaw(Prisma.sql`
              INSERT INTO ltp_1.naumen_4 (id, date, tt, responsible, time_in_work, reason, last_action, next_action)
              VALUES (
                ${nextId}, ${data.date}::date, ${row.tt || null}, ${row.responsible || null},
                ${row.timeInWork || null}, ${row.reason || null}, ${row.lastAction || null}, ${row.nextAction || null}
              )
            `);
            nextId += 1n;
          }
        }

        await tx.$executeRaw(Prisma.sql`DELETE FROM ltp_1.events_5 WHERE date = ${data.date}::date`);
        if (data.importantEventRows.length) {
          const idRows = await tx.$queryRaw<{ next_id: bigint }[]>(Prisma.sql`
            SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM ltp_1.events_5
          `);
          let nextId = idRows[0]?.next_id ?? 1n;
          for (const event of data.importantEventRows) {
            await tx.$executeRaw(Prisma.sql`
              INSERT INTO ltp_1.events_5 (id, date, event_time, event_name, what_happened, todo_control, deadline, tt_link)
              VALUES (
                ${nextId}, ${data.date}::date, ${event.eventTime || null}, ${event.eventName || null},
                ${event.whatHappened || null}, ${event.todoControl || null}, ${event.deadline || null}, ${event.ttLink || null}
              )
            `);
            nextId += 1n;
          }
        }
      });
      return { saved: true };
    } catch (error) {
      request.log.error({ err: error, actor: request.sessionUser?.login }, "Could not save LTP shift report");
      return reply.code(503).send({ error: "Не удалось сохранить передачу смены. Проверьте подключение DAPS и доступ к таблицам разделов." });
    }
  });

  app.get("/api/ltp/metabase-token", { preHandler: readAccess }, async (_request, reply) => {
    const setting = await prisma.appSetting.findUnique({ where: { key: "portal-config:ltp-metabase" } });
    const value = setting?.value && typeof setting.value === "object" && !Array.isArray(setting.value)
      ? setting.value as Record<string, unknown> : {};
    const encryptedToken = typeof value.encryptedToken === "string" ? value.encryptedToken : "";
    const metabaseSecret = encryptedToken ? decryptMetabaseSecret(encryptedToken) : config.METABASE_SECRET_KEY;
    if (!metabaseSecret) return reply.code(503).send({ error: "Metabase не настроен в конфигурации портала." });
    const instanceUrl = typeof value.instanceUrl === "string" ? value.instanceUrl : config.METABASE_INSTANCE_URL;
    const dashboardId = typeof value.dashboardId === "number" && Number.isInteger(value.dashboardId) && value.dashboardId > 0
      ? value.dashboardId : config.METABASE_DASHBOARD_ID;
    const base64url = (value: string) => Buffer.from(value).toString("base64url");
    const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify({
      resource: { dashboard: dashboardId },
      params: {},
      exp: Math.floor(Date.now() / 1000) + 10 * 60
    }));
    const unsignedToken = `${header}.${payload}`;
    const signature = createHmac("sha256", metabaseSecret).update(unsignedToken).digest("base64url");
    reply.header("Cache-Control", "no-store");
    return { token: `${unsignedToken}.${signature}`, instanceUrl };
  });

  app.get<{ Querystring: { q?: string } }>("/api/ltp/blocks-log/resources", { preHandler: readAccess }, async (request, reply) => {
    const query = z.string().trim().min(3).max(120).safeParse(request.query.q);
    if (!query.success) return reply.code(400).send({ error: "Введите не менее трёх символов." });
    try {
      const db = await database();
      const rows = await db.$queryRaw<{ resource: string }[]>(Prisma.sql`SELECT resource FROM ltp_1.resources WHERE resource ILIKE ${`%${query.data}%`} GROUP BY resource ORDER BY resource LIMIT 15`);
      return rows;
    } catch (error) {
      request.log.error({ err: error }, "Could not search LTP resources");
      return reply.code(503).send({ error: "Не удалось выполнить поиск ресурсов в PostgreSQL. Проверьте подключение DAPS." });
    }
  });

  app.post("/api/ltp/resources/import", { preHandler: writeAccess }, async (request, reply) => {
    if (!request.isMultipart()) return reply.code(406).send({ error: "Загрузите XLSX-файл." });
    try {
      const upload = await request.file();
      if (!upload || !upload.filename.toLocaleLowerCase("ru").endsWith(".xlsx")) return reply.code(400).send({ error: "Поддерживаются файлы XLSX." });
      const buffer = await upload.toBuffer();
      if (buffer.byteLength > config.UPLOAD_MAX_BYTES) return reply.code(413).send({ error: "Файл слишком большой." });
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
      const sheet = workbook.worksheets[0];
      if (!sheet || sheet.rowCount < 2) return reply.code(400).send({ error: "В XLSX нет строк справочника." });
      const headers = sheet.getRow(1).values as (string | null | undefined)[];
      const resourceColumn = headers.findIndex((value) => String(value ?? "").trim() === "Ресурс");
      const sniColumn = headers.findIndex((value) => String(value ?? "").trim() === "SNI");
      if (resourceColumn < 1 || sniColumn < 1) return reply.code(400).send({ error: "В первой строке XLSX должны быть столбцы «Ресурс» и «SNI»." });
      const entries: { resource: string; sni: string }[] = [];
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const resource = String(row.getCell(resourceColumn).text ?? "").trim();
        const sni = String(row.getCell(sniColumn).text ?? "").trim();
        if (resource || sni) entries.push({ resource, sni });
      });
      if (!entries.length) return reply.code(400).send({ error: "В XLSX нет заполненных строк." });
      if (entries.length > 100_000) return reply.code(413).send({ error: "В файле больше 100 000 строк." });
      const invalidRow = entries.findIndex((entry) => !entry.resource || !entry.sni);
      if (invalidRow >= 0) return reply.code(400).send({ error: `Заполните ресурс и SNI во всех строках (ошибка около строки ${invalidRow + 2}).` });
      const db = await database();
      await db.$transaction(async (tx) => {
        // Полная замена справочника должна сбрасывать и sequence ID,
        // чтобы новая загрузка начиналась с первого значения.
        await tx.$executeRaw`TRUNCATE TABLE ltp_1.resources RESTART IDENTITY`;
        for (let offset = 0; offset < entries.length; offset += 500) {
          const batch = entries.slice(offset, offset + 500);
          const values = Prisma.join(batch.map((entry) => Prisma.sql`(${entry.resource}, ${entry.sni})`));
          await tx.$executeRaw(Prisma.sql`INSERT INTO ltp_1.resources (resource, sni) VALUES ${values}`);
        }
      });
      return { imported: entries.length };
    } catch (error) {
      request.log.error({ err: error }, "Could not replace LTP resources from XLSX");
      return reply.code(400).send({ error: "Не удалось обновить справочник. Проверьте структуру XLSX и подключение PostgreSQL." });
    }
  });

  app.post<{ Querystring: { resource?: string } }>("/api/ltp/blocks-log/process", { preHandler: writeAccess }, async (request, reply) => {
    const resource = z.string().trim().min(1).max(120).safeParse(request.query.resource);
    if (!resource.success) return reply.code(400).send({ error: "Выберите ресурс." });
    if (!request.isMultipart()) return reply.code(406).send({ error: "Загрузите CSV-файл." });
    try {
      const upload = await request.file();
      if (!upload || !upload.filename.toLocaleLowerCase("ru").endsWith(".csv")) return reply.code(400).send({ error: "Поддерживаются файлы CSV." });
      const buffer = await upload.toBuffer();
      if (buffer.byteLength > config.UPLOAD_MAX_BYTES) return reply.code(413).send({ error: "Файл слишком большой." });
      const records = parseCsv(buffer.toString("utf8"));
      if (records.length > 100_000) return reply.code(413).send({ error: "В файле больше 100 000 строк." });
      const db = await database();
      const matches = await db.$queryRaw<{ sni: string | null }[]>(Prisma.sql`SELECT sni FROM ltp_1.resources WHERE resource = ${resource.data} LIMIT 1`);
      if (!matches.length) return reply.code(404).send({ error: "Ресурс не найден в базе данных." });
      const sni = matches.map((row) => row.sni).filter((value): value is string => Boolean(value));
      if (!sni.length) return reply.code(422).send({ error: "Для выбранного ресурса не настроены SNI." });
      const filtered = records.filter((row) => {
        const protocol = row.protocol ?? "";
        return protocol !== "HTTP" && protocol !== "HTTPS" && !protocol.startsWith("pa_");
      }).filter((row) => sni.some((value) => (row.extractedSNI ?? "").includes(value)));
      const distinct = new Map<string, BlockRow>();
      for (const item of filtered) {
        const row = Object.fromEntries(columns.map((key) => [key, item[key] ?? ""])) as BlockRow;
        const parsed = rowSchema.safeParse(row);
        if (!parsed.success) continue;
        distinct.set(JSON.stringify(parsed.data), parsed.data);
      }
      return { resource: resource.data, total: distinct.size, rows: [...distinct.values()] };
    } catch (error) {
      request.log.error({ err: error }, "Could not process LTP blocks log CSV");
      const message = error instanceof Error && (error.message.startsWith("В CSV") || error.message.startsWith("Для выбранного")) ? error.message : "Не удалось обработать CSV. Проверьте формат файла и подключение PostgreSQL.";
      return reply.code(400).send({ error: message });
    }
  });

  app.post<{ Body: { rows?: unknown; resource?: string } }>("/api/ltp/blocks-log/export", { preHandler: readAccess }, async (request, reply) => {
    const parsed = z.object({ resource: z.string().max(120), rows: z.array(rowSchema).max(100_000) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Данные для выгрузки некорректны." });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Журнал блокировок");
    sheet.addRow(["Код сайта", "Время события", "Filter IP", "Local IP", "Local Port", "Remote IP", "Remote Port", "Object ID", "Behaviour", "Тип", "Протокол", "SNI"]);
    for (const row of parsed.data.rows) sheet.addRow(columns.map((key) => row[key]));
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `Журнал_блокировок_1ЛТП_${parsed.data.resource.replace(/[^\p{L}\p{N}_.-]+/gu, "_")}.xlsx`;
    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return reply.send(Buffer.from(buffer));
  });
}
