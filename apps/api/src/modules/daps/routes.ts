import type { FastifyInstance } from "fastify";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireWorkspaceAccess } from "../auth/service.js";
import { recordLog } from "../logs/service.js";
import { getDapsDatabase, getDapsSchemas, quoteDapsSchema } from "./database.js";

const kpiFields = ["KPI-01", "KPI-02", "KPI-03", "KPI-04", "KPI-05", "KPI-06", "KPI-07"] as const;
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

export async function registerDapsRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const readAccess = requireWorkspaceAccess("DAPS");
  const writeAccess = requireWorkspaceAccess("DAPS", true);

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

}
