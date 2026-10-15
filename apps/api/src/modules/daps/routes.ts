import type { FastifyInstance } from "fastify";
import { DapsDataset, Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireWorkspaceAccess } from "../auth/service.js";
import { recordLog } from "../logs/service.js";
import { config } from "../../config.js";
import { computeKpiZero, parseDapsUpload, type ParsedDapsFile } from "./service.js";
import { getDapsDatabase, getDapsSchemas, quoteDapsSchema } from "./database.js";

const kpiFields = ["KPI-01", "KPI-02", "KPI-03", "KPI-04", "KPI-05", "KPI-06", "KPI-07"] as const;
const kpiEditorFields = ["KPI-0", ...kpiFields] as const;
const kpiUpdateSchema = z.object(Object.fromEntries(kpiEditorFields.map((field) => [field, z.string().trim().max(80).optional()])));
const kpiTableColumns: Record<typeof kpiEditorFields[number], string> = {
  "KPI-0": "KPI-0(MM_day)",
  "KPI-01": "KPI-01", "KPI-02": "KPI-02", "KPI-03": "KPI-03",
  "KPI-04": "KPI-04", "KPI-05": "KPI-05", "KPI-06": "KPI-06", "KPI-07": "KPI-07"
};
const maxFiles = 12;
const maxRowsPerFile = 20000;
const dailyKpiSaveSchema = z.object({
  k0Fact: z.number().finite(),
  k0Accum: z.number().finite(),
  k3Accum: z.number().finite()
});

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function mergeJson(existing: Prisma.JsonValue | null, update: Prisma.InputJsonObject): Prisma.InputJsonObject {
  const base = existing && typeof existing === "object" && !Array.isArray(existing)
    ? existing as Record<string, Prisma.JsonValue>
    : {};
  return { ...base, ...update } as Prisma.InputJsonObject;
}

function safeFileName(fileName: string) {
  return fileName.split(/[\\/]/).pop()?.slice(0, 200) ?? "report.xlsx";
}

async function saveParsedFile(
  tx: Prisma.TransactionClient,
  file: ParsedDapsFile,
  userId: string | undefined,
  aggregateTable: Prisma.Sql
) {
  let written = 0;
  for (const row of file.rows) {
    if (String(file.dataset) === "KPI_REPORT") {
      const date = parseDate(row.externalKey);
      if (!date) continue;
      const existing = await tx.dapsKpiDay.findUnique({ where: { date } });
      const values = mergeJson(existing?.values ?? null, row.data);
      delete (values as Record<string, unknown>)._date;
      await tx.dapsKpiDay.upsert({
        where: { date },
        create: { date, values, updatedById: userId },
        update: { values, updatedById: userId }
      });
      const updateValues: { field: string; value: string | number }[] = [];
      for (const field of kpiEditorFields) {
        const value = row.data[field];
        if (value === undefined || value === null || value === "") continue;
        if (field === "KPI-03") {
          const numeric = Number(String(value).replace(",", "."));
          if (Number.isFinite(numeric)) updateValues.push({ field, value: numeric });
          continue;
        }
        updateValues.push({ field: kpiTableColumns[field], value: String(value) });
      }
      if (updateValues.length) {
        const assignments = Prisma.join(updateValues.map(({ field, value }) => Prisma.sql`${Prisma.raw(`"${field}"`)} = ${value}`));
        const updated = await tx.$executeRaw(Prisma.sql`
          UPDATE ${aggregateTable} SET ${assignments} WHERE "Data"::date = ${date}::date
        `);
        if (!updated) {
          const columns = Prisma.join(updateValues.map(({ field }) => Prisma.raw(`"${field}"`)));
          const valuesSql = Prisma.join(updateValues.map(({ value }) => Prisma.sql`${value}`));
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO ${aggregateTable} ("Data", ${columns})
            VALUES (${row.externalKey}, ${valuesSql})
          `);
        }
      }
    } else {
      await tx.dapsReportRow.upsert({
        where: { dataset_externalKey: { dataset: file.dataset, externalKey: row.externalKey } },
        create: {
          dataset: file.dataset,
          externalKey: row.externalKey,
          reportDate: row.reportDate,
          data: row.data,
          sourceFile: file.fileName,
          updatedById: userId
        },
        update: {
          reportDate: row.reportDate,
          data: row.data,
          sourceFile: file.fileName,
          updatedById: userId
        }
      });
    }
    written += 1;
  }
  await tx.dapsImportBatch.create({
    data: { fileName: file.fileName, dataset: file.dataset, rowCount: written, createdById: userId }
  });
  return written;
}

export async function registerDapsRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const readAccess = requireWorkspaceAccess("DAPS");
  const writeAccess = requireWorkspaceAccess("DAPS", true);

  app.get("/api/daps/summary", { preHandler: readAccess }, async () => {
    const daps = await getDapsDatabase(prisma);
    const { aggregateSchema } = await getDapsSchemas(prisma);
    const aggregateTable = Prisma.raw(`${quoteDapsSchema(aggregateSchema)}."Aggregate_for_KPI"`);
    const [datasets, recentImports] = await Promise.all([
      daps.dapsReportRow.groupBy({ by: ["dataset"], _count: { _all: true }, _max: { updatedAt: true } }),
      daps.dapsImportBatch.findMany({ orderBy: { createdAt: "desc" }, take: 12, select: { id: true, fileName: true, dataset: true, rowCount: true, createdAt: true } })
    ]);
    const counts = Object.fromEntries(datasets.map((row) => [row.dataset, { rows: row._count._all, updatedAt: row._max.updatedAt }])) as Record<string, { rows: number; updatedAt: Date | null }>;
    const [kpiCount] = await daps.$queryRaw<{ rows: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS rows FROM ${aggregateTable}
      WHERE "KPI-0(MM_day)" IS NOT NULL OR "KPI-01" IS NOT NULL OR "KPI-02" IS NOT NULL OR "KPI-03" IS NOT NULL
         OR "KPI-04" IS NOT NULL OR "KPI-05" IS NOT NULL OR "KPI-06" IS NOT NULL OR "KPI-07" IS NOT NULL
    `);
    counts.KPI_REPORT = { rows: kpiCount?.rows ?? 0, updatedAt: null };
    return { counts, recentImports };
  });

  app.post("/api/daps/reports", { preHandler: writeAccess }, async (request, reply) => {
    if (!request.isMultipart()) return reply.code(406).send({ error: "Загрузите отчёты в формате XLSX." });
    const uploads: { fileName: string; buffer: Buffer }[] = [];
    try {
      for await (const part of request.parts({ limits: { fileSize: config.UPLOAD_MAX_BYTES, files: maxFiles, fields: 0, parts: maxFiles } })) {
        if (part.type !== "file") continue;
        const fileName = safeFileName(part.filename);
        if (!fileName.toLocaleLowerCase("en").endsWith(".xlsx")) {
          await part.toBuffer();
          return reply.code(400).send({ error: `Файл «${fileName}»: поддерживаются только .xlsx.` });
        }
        const buffer = await part.toBuffer();
        if (part.file.truncated) return reply.code(413).send({ error: `Файл «${fileName}» превышает допустимый размер.` });
        uploads.push({ fileName, buffer });
      }
    } catch (error) {
      app.log.warn({ err: error, actor: request.sessionUser?.login }, "Could not read DAPS report upload");
      return reply.code(400).send({ error: "Не удалось прочитать файлы. Проверьте формат XLSX и повторите загрузку." });
    }
    if (!uploads.length) return reply.code(400).send({ error: "Выберите хотя бы один XLSX-отчёт." });

    let parsedFiles: ParsedDapsFile[];
    try {
      parsedFiles = (await Promise.all(uploads.map((upload) => parseDapsUpload(upload)))).flat();
      for (const file of parsedFiles) {
        if (file.rows.length > maxRowsPerFile) {
          return reply.code(413).send({ error: `В файле «${file.fileName}» слишком много строк (максимум ${maxRowsPerFile.toLocaleString("ru-RU")}).` });
        }
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Не удалось обработать отчёты." });
    }

    try {
      const daps = await getDapsDatabase(prisma);
      const { aggregateSchema } = await getDapsSchemas(prisma);
      const aggregateTable = Prisma.raw(`${quoteDapsSchema(aggregateSchema)}."Aggregate_for_KPI"`);
      const result = await daps.$transaction(async (tx) => {
        const imported: { fileName: string; dataset: DapsDataset; rows: number }[] = [];
        for (const file of parsedFiles) {
          const rows = await saveParsedFile(tx, file, undefined, aggregateTable);
          imported.push({ fileName: file.fileName, dataset: file.dataset, rows });
        }
        const aggregateRows = parsedFiles
          .filter((file) => file.dataset === DapsDataset.AGGREGATE)
          .flatMap((file) => file.rows.map((row) => ({ data: row.data as Prisma.JsonValue })));
        const kpiZero = computeKpiZero(aggregateRows);
        for (const item of kpiZero) {
          const current = await tx.dapsKpiDay.findUnique({ where: { date: item.date } });
          await tx.dapsKpiDay.upsert({
            where: { date: item.date },
            create: { date: item.date, values: item.values },
            update: { values: mergeJson(current?.values ?? null, item.values) }
          });
        }
        return { imported, kpiZeroDays: kpiZero.length };
      }, { timeout: 120000 });
      await recordLog(prisma, {
        level: "INFO",
        action: "DAPS_REPORT_IMPORT",
        message: `Загружено файлов: ${uploads.length}; обработано строк: ${result.imported.reduce((sum, item) => sum + item.rows, 0)}.`,
        actorId: request.sessionUser?.id ?? null,
        actorLogin: request.sessionUser?.login ?? null,
        actorRole: request.sessionUser?.role ?? null,
        request: { fileNames: [...new Set(uploads.map((upload) => upload.fileName))] }
      });
      return reply.code(201).send(result);
    } catch (error) {
      app.log.error({ err: error, actor: request.sessionUser?.login }, "Could not import DAPS reports");
      return reply.code(500).send({ error: "Не удалось сохранить отчёты в базе DAPS. Данные не были импортированы." });
    }
  });

  app.get<{ Querystring: { date?: string } }>("/api/daps/kpi", { preHandler: readAccess }, async (request, reply) => {
    const date = parseDate(request.query.date);
    if (!date) return reply.code(400).send({ error: "Укажите дату в формате ГГГГ-ММ-ДД." });
    const daps = await getDapsDatabase(prisma);
    const { aggregateSchema } = await getDapsSchemas(prisma);
    const aggregateTable = Prisma.raw(`${quoteDapsSchema(aggregateSchema)}."Aggregate_for_KPI"`);
    const [row] = await daps.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
      SELECT "KPI-0(MM_day)" AS "KPI-0", "KPI-01", "KPI-02", "KPI-03", "KPI-04", "KPI-05", "KPI-06", "KPI-07"
      FROM ${aggregateTable}
      WHERE "Data"::date = ${date}::date
      LIMIT 1
    `);
    if (!row) return reply.code(404).send({ error: "За эту дату данных KPI нет." });
    return { date: request.query.date, values: row };
  });

  app.get<{ Querystring: { date?: string } }>("/api/daps/daily-kpi", { preHandler: readAccess }, async (request, reply) => {
    const date = parseDate(request.query.date);
    if (!date) return reply.code(400).send({ error: "Укажите дату в формате ГГГГ-ММ-ДД." });
    const daps = await getDapsDatabase(prisma);
    const { sourceSchema, aggregateSchema } = await getDapsSchemas(prisma);
    const sourceTable = Prisma.raw(`${quoteDapsSchema(sourceSchema)}."all_k"`);
    const aggregateTable = Prisma.raw(`${quoteDapsSchema(aggregateSchema)}."Aggregate_for_KPI"`);
    const [tables] = await daps.$queryRaw<{ allK: string | null; aggregate: string | null }[]>`
      SELECT to_regclass(${`${quoteDapsSchema(sourceSchema)}.all_k`})::text AS "allK",
             to_regclass(${`${quoteDapsSchema(aggregateSchema)}."Aggregate_for_KPI"`})::text AS aggregate
    `;
    if (!tables?.allK) {
      return reply.code(424).send({ error: `В подключённой базе не найдена таблица ${sourceSchema}.all_k. Проверьте выбранную схему или создайте таблицу в этой базе.` });
    }
    if (!tables.aggregate) {
      return reply.code(424).send({ error: `В подключённой базе не найдена таблица ${aggregateSchema}.Aggregate_for_KPI. Проверьте выбранную схему или создайте таблицу в этой базе.` });
    }
    const rows = await daps.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
      WITH monthly_stats AS (
        SELECT
          AVG("KPI-01") AS avg_kpi_01, AVG("KPI-02") AS avg_kpi_02,
          AVG("KPI-03") AS avg_kpi_03, AVG("KPI-04") AS avg_kpi_04,
          AVG("KPI-05") AS avg_kpi_05, AVG("KPI-06") AS avg_kpi_06,
          AVG("KPI-07") AS avg_kpi_07
        FROM ${sourceTable}
        WHERE date::date >= date_trunc('month', ${date}::date)::date AND date::date <= ${date}::date
      )
      SELECT t.date::date AS date,
        t."KPI-01", t."KPI-02", t."KPI-03", t."KPI-04", t."KPI-05", t."KPI-06", t."KPI-07",
        t."KPI-03(AVR)", t."KPI-03(PNR)",
        m.avg_kpi_01, m.avg_kpi_02, m.avg_kpi_03, m.avg_kpi_04, m.avg_kpi_05, m.avg_kpi_06, m.avg_kpi_07,
        a."KPI-03(CUMM)", a."KPI-0(MM_day)", a."KPI-0(MM_mounth)"
      FROM ${sourceTable} t
      CROSS JOIN monthly_stats m
      LEFT JOIN ${aggregateTable} a ON a."Data"::date = t.date::date
      WHERE t.date::date = ${date}::date
    `);
    const row = rows[0];
    const values = row ? Object.fromEntries([
      ...kpiFields.map((field) => [field, row[field]] as const),
      ["KPI-03(AVR)", row["KPI-03(AVR)"]] as const, ["KPI-03(PNR)", row["KPI-03(PNR)"]] as const,
      ["KPI-03(CUMM)", row["KPI-03(CUMM)"]] as const, ["KPI-0(MM_day)", row["KPI-0(MM_day)"]] as const,
      ["KPI-0(MM_mounth)", row["KPI-0(MM_mounth)"]] as const
    ]) : null;
    const monthlyAverages = row ? Object.fromEntries(kpiFields.map((field, index) => [field, row[`avg_kpi_${String(index + 1).padStart(2, "0")}`]])) : {};
    return {
      date: request.query.date,
      values,
      monthlyAverages,
      monthLabel: date.toLocaleDateString("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" })
    };
  });

  app.get("/api/daps/daily-kpi/chart", { preHandler: readAccess }, async () => {
    const daps = await getDapsDatabase(prisma);
    const { aggregateSchema } = await getDapsSchemas(prisma);
    const aggregateTable = Prisma.raw(`${quoteDapsSchema(aggregateSchema)}."Aggregate_for_KPI"`);
    const rows = await daps.$queryRaw<{ date: Date; values: Record<string, unknown> }[]>(Prisma.sql`
      SELECT "Data"::date AS date,
        jsonb_build_object(
          'KPI-03', "KPI-03", 'KPI-03(AVR)', "KPI-03(AVR)",
          'KPI-03(PNR)', "KPI-03(PNR)", 'KPI-03(CUMM)', "KPI-03(CUMM)"
        ) AS "values"
      FROM ${aggregateTable}
      ORDER BY "Data" ASC
    `);
    return rows.map((row) => ({ date: row.date.toISOString().slice(0, 10), values: row.values }));
  });

  app.put<{ Params: { date: string } }>("/api/daps/daily-kpi/:date", { preHandler: writeAccess }, async (request, reply) => {
    const date = parseDate(request.params.date);
    if (!date) return reply.code(400).send({ error: "Укажите дату в формате ГГГГ-ММ-ДД." });
    const parsed = dailyKpiSaveSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Проверьте значения К0 и накопленного К3." });
    const daps = await getDapsDatabase(prisma);
    const { aggregateSchema } = await getDapsSchemas(prisma);
    const aggregateTable = Prisma.raw(`${quoteDapsSchema(aggregateSchema)}."Aggregate_for_KPI"`);
    const updated = await daps.$queryRaw<{ date: Date }[]>(Prisma.sql`
      UPDATE ${aggregateTable}
      SET "KPI-0(MM_day)" = ${String(parsed.data.k0Fact)},
          "KPI-0(MM_mounth)" = ${String(parsed.data.k0Accum)},
          "KPI-03(CUMM)" = ${String(parsed.data.k3Accum)}
      WHERE "Data"::date = ${date}::date
      RETURNING "Data"::date AS date
    `);
    if (!updated.length) return reply.code(404).send({ error: `В таблице ${aggregateSchema}.Aggregate_for_KPI нет строки за эту дату. Сначала добавьте дату в таблицу и повторите сохранение.` });
    await recordLog(prisma, {
      level: "INFO", action: "DAPS_DAILY_KPI_UPDATE",
      message: `Обновлены показатели ежедневного отчёта KPI в ${aggregateSchema}.Aggregate_for_KPI за ${request.params.date}.`,
      actorId: request.sessionUser?.id ?? null, actorLogin: request.sessionUser?.login ?? null,
      actorRole: request.sessionUser?.role ?? null, entityId: request.params.date
    });
    return { date: request.params.date };
  });

  app.put<{ Params: { date: string } }>("/api/daps/kpi/:date", { preHandler: writeAccess }, async (request, reply) => {
    const date = parseDate(request.params.date);
    if (!date) return reply.code(400).send({ error: "Укажите дату в формате ГГГГ-ММ-ДД." });
    const parsed = kpiUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Проверьте значения KPI-0 и KPI 1–7." });
    const kpi03 = parsed.data["KPI-03"]?.replace(",", ".").trim();
    if (kpi03 && !Number.isFinite(Number(kpi03))) return reply.code(400).send({ error: "Для KPI-03 укажите число." });
    const daps = await getDapsDatabase(prisma);
    const { aggregateSchema } = await getDapsSchemas(prisma);
    const aggregateTable = Prisma.raw(`${quoteDapsSchema(aggregateSchema)}."Aggregate_for_KPI"`);
    const updated = await daps.$queryRaw<{ date: Date }[]>(Prisma.sql`
      UPDATE ${aggregateTable}
      SET "KPI-0(MM_day)" = ${parsed.data["KPI-0"] ?? null},
          "KPI-01" = ${parsed.data["KPI-01"] ?? null},
          "KPI-02" = ${parsed.data["KPI-02"] ?? null},
          "KPI-03" = ${kpi03 ? Number(kpi03) : null},
          "KPI-04" = ${parsed.data["KPI-04"] ?? null},
          "KPI-05" = ${parsed.data["KPI-05"] ?? null},
          "KPI-06" = ${parsed.data["KPI-06"] ?? null},
          "KPI-07" = ${parsed.data["KPI-07"] ?? null}
      WHERE "Data"::date = ${date}::date
      RETURNING "Data"::date AS date
    `);
    if (!updated.length) return reply.code(404).send({ error: `В таблице ${aggregateSchema}.Aggregate_for_KPI нет строки за ${request.params.date}. Сначала загрузите отчёт за эту дату.` });
    await recordLog(prisma, {
      level: "INFO",
      action: "DAPS_KPI_UPDATE",
      message: `Вручную обновлены KPI-0 и KPI 1–7 в ${aggregateSchema}.Aggregate_for_KPI за ${date.toISOString().slice(0, 10)}.`,
      actorId: request.sessionUser?.id ?? null,
      actorLogin: request.sessionUser?.login ?? null,
      actorRole: request.sessionUser?.role ?? null,
      entityId: date.toISOString().slice(0, 10)
    });
    return { date: request.params.date };
  });
}
