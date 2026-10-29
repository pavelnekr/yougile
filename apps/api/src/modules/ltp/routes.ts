import type { FastifyInstance } from "fastify";
import { Prisma, type PortalWorkspace, type PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import { z } from "zod";
import { config } from "../../config.js";
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
