import multipart from "@fastify/multipart";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { ImportBatchStatus, ImportRowStatus, OperationStatus, OperationType, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { config } from "../../config.js";
import { YougileClient, YougileApiError } from "../../integrations/yougile/client.js";
import { getChatMessages, getMessageText, getMessageTimestamp } from "../../integrations/yougile/chat.js";
import { UserYougileCredentialError, getUserYougileClient } from "../../integrations/yougile/user-client.js";
import { operationQueue } from "../../jobs/queue.js";
import { getAssignmentUsers } from "../users/service.js";
import {
  AssignmentValidationError,
  maxSitesPerOperation,
  previewAssignments,
  tooManySitesError
} from "../assignments/service.js";
import { importRemovalSchema, prepareImportRemoval } from "../assignments/removal.js";
import { getPlannedSites } from "../sites/service.js";
import { renderCommentTemplate } from "./comment-template.js";
import { parsePlanWorkbook } from "./xlsx.js";

const maxStoredImports = 5;
const importRetentionLockId = 847201563;
// Сколько строк XLSX отдаём в просмотр содержимого. Дальше пользователь всё
// равно не читает таблицу глазами, а страница с несколькими тысячами ячеек
// перестаёт прокручиваться.
const DETAIL_ROW_LIMIT = 300;

const previewSchema = z.object({
  rowNumbers: z.array(z.number().int().positive()).min(1).max(maxSitesPerOperation, tooManySitesError("строк XLSX"))
    .refine((rows) => new Set(rows).size === rows.length, "В плане выбраны повторяющиеся строки."),
  workType: z.enum(["filter", "balancers", "bypasses", "ehw", "other"]),
  commentTemplate: z.string().trim().min(1, "Введите шаблон комментария.")
    .max(10_000, "Шаблон комментария не должен превышать 10 000 символов.")
});

const applySchema = previewSchema;
const workCheckSchema = z.object({
  rowNumbers: z.array(z.number().int().positive()).min(1)
    .refine((rows) => new Set(rows).size === rows.length, "Выбраны повторяющиеся строки XLSX.")
});

type PreparedImportItem = {
  rowNumber: number;
  importRowId: string;
  siteId: string;
  address: string | null;
  engineerName: string;
  taskId: string;
  userId: string;
  currentUserIds: string[];
  alreadyAssigned: boolean;
  comment: string;
};

function normalizeEngineerName(name: string) {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
}

function describeImportRowProblems(row: {
  siteId: string | null;
  address?: string | null;
  engineerName: string | null;
  engineerUserId: string | null;
  yougileTaskId?: string | null;
  status: ImportRowStatus;
}) {
  const problems: string[] = [];
  if (!row.siteId) problems.push("В строке не указан номер площадки.");
  else if (!row.yougileTaskId) problems.push("Площадка не найдена в активном плане YouGile.");
  if (row.status === ImportRowStatus.DUPLICATE_SITE) problems.push("Площадка указана в XLSX больше одного раза.");
  if (!row.engineerName) problems.push("В строке не указан инженер.");
  else if (!row.engineerUserId) problems.push("Инженер с таким именем не найден в YouGile или совпадение неоднозначно.");
  return problems.join(" ");
}

function readError(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка чтения XLSX.";
}

export async function registerImportRoutes(
  app: FastifyInstance,
  prisma: PrismaClient
) {
  await app.register(multipart, {
    limits: { fileSize: config.UPLOAD_MAX_BYTES, files: 1, fields: 0, parts: 1 }
  });

  app.get("/api/imports", async (_request, reply) => {
    try {
      const batches = await prisma.importBatch.findMany({
        orderBy: { createdAt: "desc" },
        take: maxStoredImports,
        include: {
          createdBy: { select: { displayName: true } },
          _count: { select: { rows: true } }
        }
      });
      return {
        items: batches.map((batch) => ({
          id: batch.id,
          fileName: batch.fileName,
          rowCount: batch._count.rows,
          uploadedBy: batch.createdBy?.displayName ?? "Локальный оператор",
          createdAt: batch.createdAt.toISOString(),
          status: batch.status
        }))
      };
    } catch (error) {
      app.log.error({ err: error }, "Could not load XLSX import history");
      return reply.code(500).send({ error: "Не удалось загрузить историю XLSX." });
    }
  });

  app.get<{ Params: { id: string } }>("/api/imports/:id", async (request, reply) => {
    try {
      const batch = await prisma.importBatch.findUnique({
        where: { id: request.params.id },
        include: {
          createdBy: { select: { displayName: true } },
          _count: { select: { rows: true } },
          // Содержимое показывается целиком, поэтому число строк ограничено:
          // без take батча на 1200 строк превращалась в 37 тысяч ячеек и
          // растягивала документ до 33 тысяч пикселей. Имена столбцов у всех
          // строк одного листа одинаковые, так что по выборке columns тоже верны.
          rows: { orderBy: { rowNumber: "asc" }, take: DETAIL_ROW_LIMIT }
        }
      });
      if (!batch) return reply.code(404).send({ error: "Загрузка XLSX не найдена." });

      const columns = [...new Set(batch.rows.flatMap((row) =>
        row.rawData && typeof row.rawData === "object" && !Array.isArray(row.rawData)
          ? Object.keys(row.rawData)
          : []
      ))];
      return {
        id: batch.id,
        fileName: batch.fileName,
        rowCount: batch.rowCount,
        uploadedBy: batch.createdBy?.displayName ?? "Локальный оператор",
        createdAt: batch.createdAt.toISOString(),
        status: batch.status,
        sheetName: batch.metadata && typeof batch.metadata === "object" && !Array.isArray(batch.metadata) &&
          "sheetName" in batch.metadata && typeof batch.metadata.sheetName === "string"
          ? batch.metadata.sheetName
          : null,
        columns,
        rowsShown: batch.rows.length,
        rowsTotal: batch._count.rows,
        rowsTruncated: batch._count.rows > batch.rows.length,
        rows: batch.rows.map((row) => ({
          rowNumber: row.rowNumber,
          siteId: row.siteId,
          address: row.address,
          engineerName: row.engineerName,
          status: row.status,
          rawData: row.rawData
        }))
      };
    } catch (error) {
      app.log.error({ err: error, importId: request.params.id }, "Could not load XLSX import contents");
      return reply.code(500).send({ error: "Не удалось загрузить содержимое XLSX." });
    }
  });

  app.post<{ Params: { id: string } }>("/api/imports/:id/work-check", async (request, reply) => {
    const parsed = workCheckSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Выберите строки XLSX для проверки комментариев." });

    try {
      const yougile = await getUserYougileClient(prisma, request.sessionUser?.id);
      const batch = await prisma.importBatch.findUnique({
        where: { id: request.params.id },
        include: {
          rows: {
            where: { rowNumber: { in: parsed.data.rowNumbers } },
            orderBy: { rowNumber: "asc" },
            select: { rowNumber: true, siteId: true, yougileTaskId: true }
          }
        }
      });
      if (!batch) return reply.code(404).send({ error: "Загрузка XLSX не найдена." });
      if (batch.rows.length !== parsed.data.rowNumbers.length) {
        return reply.code(400).send({ error: "Часть строк не относится к выбранному файлу XLSX." });
      }

      const uniqueTaskIds = [...new Set(batch.rows.flatMap((row) => row.yougileTaskId ? [row.yougileTaskId] : []))];
      const latestByTaskId = new Map<string, { text: string | null; error: string | null }>();
      for (let index = 0; index < uniqueTaskIds.length; index += 5) {
        const taskIds = uniqueTaskIds.slice(index, index + 5);
        const messages = await Promise.all(taskIds.map(async (taskId) => {
          try {
            const response = await yougile.request(`chats/${encodeURIComponent(taskId)}/messages?limit=100&offset=0`);
            const candidates = getChatMessages(response)
              .filter((message): message is Record<string, unknown> => Boolean(message) && typeof message === "object" && !Array.isArray(message))
              .map((message) => ({ text: getMessageText(message), timestamp: getMessageTimestamp(message) }))
              .filter((message) => message.text !== null);
            candidates.sort((left, right) => (right.timestamp ?? -Infinity) - (left.timestamp ?? -Infinity));
            return [taskId, { text: candidates[0]?.text ?? null, error: null }] as const;
          } catch (error) {
            app.log.error({ err: error, taskId }, "Could not load latest YouGile chat message");
            return [taskId, {
              text: null,
              error: error instanceof YougileApiError && (error.statusCode === 401 || error.statusCode === 403)
                ? "Нет доступа к чату задачи."
                : error instanceof YougileApiError && error.statusCode === 404
                  ? "Чат задачи не найден."
                  : "Не удалось загрузить комментарий из YouGile."
            }] as const;
          }
        }));
        for (const [taskId, result] of messages) latestByTaskId.set(taskId, result);
      }

      return {
        importId: batch.id,
        fileName: batch.fileName,
        items: batch.rows.map((row) => {
          const result = row.yougileTaskId ? latestByTaskId.get(row.yougileTaskId) : undefined;
          return {
            rowNumber: row.rowNumber,
            siteId: row.siteId,
            comment: result?.text ?? null,
            message: result?.error ?? (result?.text
              ? "Последний комментарий найден."
              : row.yougileTaskId ? "Комментариев пока нет." : "Площадка не найдена в YouGile.")
          };
        })
      };
    } catch (error) {
      if (error instanceof UserYougileCredentialError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      app.log.error({ err: error, importId: request.params.id }, "Could not check latest comments for XLSX rows");
      return reply.code(502).send({ error: "Не удалось проверить комментарии по выбранному XLSX." });
    }
  });

  app.post("/api/imports/preview", async (request, reply) => {
    try {
      const yougile = await getUserYougileClient(prisma, request.sessionUser?.id, { retryOnRateLimit: true });
      const upload = await request.file();
      if (!upload) return reply.code(400).send({ error: "Выберите XLSX-файл плана." });

      const filename = upload.filename.split(/[\\/]/).pop() ?? "";
      if (!filename.toLocaleLowerCase("en").endsWith(".xlsx")) {
        await upload.toBuffer();
        return reply.code(400).send({ error: "Поддерживаются файлы .xlsx." });
      }

      const buffer = await upload.toBuffer();
      const parsedPlan = await parsePlanWorkbook(buffer);
      const sites = await getPlannedSites(yougile);
      const users = await getAssignmentUsers(yougile);
      const taskBySiteId = new Map<string, typeof sites[number]>();
      for (const site of sites) {
        if (!taskBySiteId.has(site.siteNumber)) taskBySiteId.set(site.siteNumber, site);
      }

      const usersByName = new Map<string, (typeof users)[number][]>();
      for (const user of users) {
        const normalizedName = normalizeEngineerName(user.name);
        const matches = usersByName.get(normalizedName) ?? [];
        matches.push(user);
        usersByName.set(normalizedName, matches);
      }

      const rowCounts = new Map<string, number>();
      for (const row of parsedPlan.rows) {
        if (row.siteId) rowCounts.set(row.siteId, (rowCounts.get(row.siteId) ?? 0) + 1);
      }

      const rows = parsedPlan.rows.map((row) => {
        const duplicate = row.siteId ? (rowCounts.get(row.siteId) ?? 0) > 1 : false;
        const site = row.siteId ? taskBySiteId.get(row.siteId) : undefined;
        const engineerMatches = row.engineerName
          ? usersByName.get(normalizeEngineerName(row.engineerName)) ?? []
          : [];
        const engineer = engineerMatches.length === 1 ? engineerMatches[0] : undefined;
        const status = !row.siteId || !row.engineerName
          ? ImportRowStatus.INVALID_ROW
          : duplicate
            ? ImportRowStatus.DUPLICATE_SITE
            : !site
              ? ImportRowStatus.SITE_NOT_FOUND
              : !engineer
                ? ImportRowStatus.ENGINEER_NOT_FOUND
                : ImportRowStatus.READY;
        return {
          ...row,
          engineerUserId: engineer?.id ?? null,
          yougileTaskId: site?.taskId ?? null,
          status,
          rawData: row.rawData
        };
      });

      const checksum = createHash("sha256").update(buffer).digest("hex");
      const batch = await prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`SELECT pg_advisory_xact_lock(${importRetentionLockId})::text AS locked`;
        const createdBatch = await transaction.importBatch.create({
          data: {
            fileName: filename.slice(0, 255),
            checksum,
            rowCount: rows.length,
            // Загрузивший: по нему считается статистика сотрудников в админке.
            createdById: request.sessionUser?.id ?? null,
            metadata: {
              sheetName: parsedPlan.sheetName,
              importedAt: new Date().toISOString()
            },
            rows: {
              create: rows.map((row) => ({
                rowNumber: row.rowNumber,
                siteId: row.siteId,
                address: row.address,
                engineerName: row.engineerName,
                engineerUserId: row.engineerUserId,
                yougileTaskId: row.yougileTaskId,
                status: row.status,
                rawData: row.rawData
              }))
            }
          }
        });
        const storedBatches = await transaction.importBatch.findMany({
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true, status: true }
        });
        const excessCount = Math.max(0, storedBatches.length - maxStoredImports);
        const expiredBatchIds = storedBatches
          .slice()
          .reverse()
          .slice(0, excessCount)
          .map((storedBatch) => storedBatch.id);
        if (expiredBatchIds.length > 0) {
          await transaction.importBatch.deleteMany({ where: { id: { in: expiredBatchIds } } });
        }
        return createdBatch;
      });

      return {
        importId: batch.id,
        fileName: batch.fileName,
        sheetName: parsedPlan.sheetName,
        rowCount: rows.length,
        counts: {
          ready: rows.filter((row) => row.status === ImportRowStatus.READY).length,
          siteNotFound: rows.filter((row) => row.status === ImportRowStatus.SITE_NOT_FOUND).length,
          engineerNotFound: rows.filter((row) => Boolean(row.engineerName) && !row.engineerUserId).length,
          invalid: rows.filter((row) => row.status === ImportRowStatus.INVALID_ROW).length,
          duplicate: rows.filter((row) => row.status === ImportRowStatus.DUPLICATE_SITE).length
        },
        rows: rows.map((row) => ({
          rowNumber: row.rowNumber,
          siteId: row.siteId,
          address: row.address,
          engineerName: row.engineerName,
          engineerUserId: row.engineerUserId,
          yougileTaskId: row.yougileTaskId,
          status: row.status
        }))
      };
    } catch (error) {
      if (error instanceof UserYougileCredentialError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof Error && error.message.startsWith("Request file size limit")) {
        return reply.code(413).send({ error: `Файл превышает лимит ${Math.round(config.UPLOAD_MAX_BYTES / 1024 / 1024)} МБ.` });
      }
      if (error instanceof YougileApiError) {
        app.log.error({ err: error }, "Could not compare XLSX plan to YouGile");
        return reply.code(502).send({ error: "Не удалось сопоставить XLSX с YouGile. Файл не импортирован." });
      }
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: "YouGile вернул данные в неожиданном формате. Файл не импортирован." });
      }
      app.log.error({ err: error }, "Could not import XLSX plan");
      return reply.code(400).send({ error: readError(error) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/imports/:id/problematic-sites.xlsx", async (request, reply) => {
    try {
      const batch = await prisma.importBatch.findUnique({
        where: { id: request.params.id },
        include: {
          rows: {
            where: { status: { not: ImportRowStatus.READY } },
            orderBy: { rowNumber: "asc" }
          }
        }
      });
      if (!batch) return reply.code(404).send({ error: "Загрузка XLSX не найдена." });

      const operations = await prisma.operation.findMany({
        where: {
          type: OperationType.ASSIGN,
          metadata: { path: ["importBatchId"], equals: batch.id }
        },
        include: {
          items: {
            where: { status: "FAILED" },
            include: { importRow: true }
          }
        }
      });

      const problemRows = [
        ...batch.rows.map((row) => ({
          rowNumber: row.rowNumber,
          siteId: row.siteId,
          address: row.address,
          engineerName: row.engineerName,
          problem: describeImportRowProblems(row),
          source: "Ошибка строки XLSX"
        })),
        ...operations.flatMap((operation) => operation.items.map((item) => ({
          rowNumber: item.importRow?.rowNumber ?? null,
          siteId: item.siteId,
          address: item.importRow?.address ?? null,
          engineerName: item.importRow?.engineerName ?? null,
          problem: item.errorMessage ?? "Не удалось выполнить назначение или отправить комментарий.",
          source: "Ошибка операции"
        })))
      ];

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Проблемные площадки");
      worksheet.columns = [
        { header: "Строка XLSX", key: "rowNumber", width: 14 },
        { header: "ID площадки", key: "siteId", width: 16 },
        { header: "Адрес", key: "address", width: 50 },
        { header: "Инженер", key: "engineerName", width: 28 },
        { header: "Проблема", key: "problem", width: 60 },
        { header: "Источник", key: "source", width: 24 }
      ];
      worksheet.addRows(problemRows);
      worksheet.getRow(1).font = { bold: true };
      worksheet.views = [{ state: "frozen", ySplit: 1 }];
      worksheet.autoFilter = { from: "A1", to: "F1" };

      const workbookBuffer = await workbook.xlsx.writeBuffer();
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="problematic-sites-${batch.id}.xlsx"`)
        .send(Buffer.from(workbookBuffer));
    } catch (error) {
      app.log.error({ err: error, importId: request.params.id }, "Could not export problematic XLSX rows");
      return reply.code(500).send({ error: "Не удалось сформировать XLSX со списком проблемных площадок." });
    }
  });

  async function prepareImportAssignment(
    importId: string,
    input: z.infer<typeof previewSchema>,
    yougile: YougileClient
  ): Promise<{ batchId: string; fileName: string; items: PreparedImportItem[]; employees: Awaited<ReturnType<typeof getAssignmentUsers>> }> {
    const batch = await prisma.importBatch.findUnique({
      where: { id: importId },
      include: { rows: { where: { rowNumber: { in: input.rowNumbers } }, orderBy: { rowNumber: "asc" } } }
    });
    if (!batch || batch.status !== ImportBatchStatus.PREVIEW) {
      throw new AssignmentValidationError("Загрузка не найдена или уже обработана. Загрузите XLSX ещё раз.");
    }
    if (batch.rows.length !== input.rowNumbers.length) {
      throw new AssignmentValidationError("Часть строк не относится к этой загрузке XLSX.");
    }

    const employees = await getAssignmentUsers(yougile);

    const usersById = new Map(employees.map((user) => [user.id, user]));
    const siteIds = new Set<string>();
    const items = [];
    const allTasks = await getPlannedSites(yougile);
    const taskById = new Map(allTasks.map((site) => [site.taskId, site]));

    for (const row of batch.rows) {
      if (
        row.status !== ImportRowStatus.READY ||
        !row.siteId ||
        !row.engineerName ||
        !row.engineerUserId ||
        !row.yougileTaskId
      ) {
        throw new AssignmentValidationError(`Строка ${row.rowNumber}: площадка не найдена или строка отмечена ошибкой.`);
      }
      if (siteIds.has(row.siteId)) {
        throw new AssignmentValidationError(`Площадка ${row.siteId} выбрана более одного раза.`);
      }
      siteIds.add(row.siteId);

      const user = usersById.get(row.engineerUserId);
      if (!user) {
        throw new AssignmentValidationError(`Инженер «${row.engineerName}» больше не найден в YouGile. Загрузите XLSX ещё раз.`);
      }
      if (normalizeEngineerName(user.name) !== normalizeEngineerName(row.engineerName)) {
        throw new AssignmentValidationError(`Имя инженера в строке ${row.rowNumber} изменилось в YouGile. Загрузите XLSX ещё раз.`);
      }
      const plannedTask = taskById.get(row.yougileTaskId);
      if (!plannedTask || plannedTask.siteNumber !== row.siteId) {
        throw new AssignmentValidationError(`Строка ${row.rowNumber}: площадка больше не находится в активном плане YouGile.`);
      }
      items.push({ row, user });
    }

    const grouped = new Map<string, string[]>();
    for (const { row, user } of items) {
      const taskIds = grouped.get(user.id) ?? [];
      taskIds.push(row.yougileTaskId!);
      grouped.set(user.id, taskIds);
    }

    const previews = new Map<string, Awaited<ReturnType<typeof previewAssignments>>["items"][number]>();
    for (const [userId, taskIds] of grouped) {
      const preview = await previewAssignments(yougile, { userId, taskIds });
      for (const item of preview.items) previews.set(item.taskId, item);
    }

    return {
      batchId: batch.id,
      fileName: batch.fileName,
      employees,
      items: items.map(({ row, user }) => {
        const preview = previews.get(row.yougileTaskId!);
        if (!preview) throw new Error(`Preview missing for imported row ${row.rowNumber}`);
        return {
          rowNumber: row.rowNumber,
          importRowId: row.id,
          siteId: row.siteId!,
          address: row.address,
          engineerName: row.engineerName!,
          taskId: row.yougileTaskId!,
          userId: user.id,
          currentUserIds: preview.currentUserIds,
          alreadyAssigned: preview.alreadyAssigned,
          comment: renderCommentTemplate(input.commentTemplate, row.rawData)
        };
      })
    };
  }

  app.post<{ Params: { id: string } }>("/api/imports/:id/assignment-preview", async (request, reply) => {
    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Выберите строки плана, где площадка и инженер найдены в YouGile." });
    try {
      const yougile = await getUserYougileClient(prisma, request.sessionUser?.id, { retryOnRateLimit: true });
      const prepared = await prepareImportAssignment(request.params.id, parsed.data, yougile);
      return {
        importId: prepared.batchId,
        count: prepared.items.length,
        alreadyAssigned: prepared.items.filter((item) => item.alreadyAssigned).length,
        items: prepared.items.map((item) => ({
          ...item,
          currentEngineers: item.currentUserIds.map((id) => ({
            id,
            name: prepared.employees.find((user) => user.id === id)?.name ?? "Сотрудник не найден"
          }))
        }))
      };
    } catch (error) {
      if (error instanceof UserYougileCredentialError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof AssignmentValidationError) return reply.code(400).send({ error: error.message });
      app.log.error({ err: error }, "Could not prepare XLSX assignment preview");
      return reply.code(502).send({ error: "Не удалось проверить выбранные задачи в YouGile." });
    }
  });

  app.post<{ Params: { id: string } }>("/api/imports/:id/removal-preview", async (request, reply) => {
    const parsed = importRemovalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Выберите уникальные строки XLSX для снятия инженеров." });
    try {
      const yougile = await getUserYougileClient(prisma, request.sessionUser?.id, { retryOnRateLimit: true });
      const prepared = await prepareImportRemoval(yougile, prisma, request.params.id, parsed.data.rowNumbers);
      return {
        importId: prepared.batchId,
        fileName: prepared.fileName,
        count: prepared.items.length,
        willRemove: prepared.items.filter((item) => item.willRemove).length,
        items: prepared.items.map((item) => ({
          rowNumber: item.rowNumber,
          siteId: item.siteId,
          address: item.address,
          engineerName: item.engineerName,
          willRemove: item.willRemove,
          assignedEngineerNames: item.assignedEngineerNames,
          remainingEngineerNames: item.remainingEngineerNames
        }))
      };
    } catch (error) {
      if (error instanceof UserYougileCredentialError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof AssignmentValidationError) return reply.code(400).send({ error: error.message });
      app.log.error({ err: error, importId: request.params.id }, "Could not prepare XLSX engineer removal preview");
      return reply.code(502).send({ error: "Не удалось проверить назначения по выбранному XLSX." });
    }
  });

  app.post<{ Params: { id: string } }>("/api/imports/:id/remove", async (request, reply) => {
    const parsed = importRemovalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Выберите проверенные строки XLSX для снятия инженеров." });
    try {
      const yougile = await getUserYougileClient(prisma, request.sessionUser?.id, { retryOnRateLimit: true });
      const prepared = await prepareImportRemoval(yougile, prisma, request.params.id, parsed.data.rowNumbers);
      const operation = await prisma.operation.create({
        data: {
          type: OperationType.REMOVE,
          status: OperationStatus.QUEUED,
          // Автор операции: по нему считается статистика сотрудников в админке.
          createdById: request.sessionUser?.id ?? null,
          total: prepared.items.length,
          metadata: { sourceBatchId: prepared.batchId, fileName: prepared.fileName },
          items: {
            create: prepared.items.map((item) => ({
              importRowId: item.importRowId,
              siteId: item.siteId,
              requestedUserId: item.userId,
              beforeData: {
                taskId: item.taskId,
                title: item.title,
                assignedUserIds: item.assignedUserIds,
                engineerName: item.engineerName,
                importRowNumber: item.rowNumber
              }
            }))
          }
        }
      });

      try {
        await operationQueue.add("remove-engineers", { operationId: operation.id }, { jobId: operation.id });
      } catch (error) {
        await prisma.operation.update({
          where: { id: operation.id },
          data: { status: OperationStatus.FAILED, message: "Не удалось поставить операцию в очередь.", finishedAt: new Date() }
        });
        throw error;
      }

      return reply.code(202).send({ operationId: operation.id });
    } catch (error) {
      if (error instanceof UserYougileCredentialError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof AssignmentValidationError) return reply.code(400).send({ error: error.message });
      app.log.error({ err: error, importId: request.params.id }, "Could not enqueue XLSX engineer removal");
      return reply.code(502).send({ error: "Не удалось запустить снятие инженеров. Изменения не применены." });
    }
  });

  app.post<{ Params: { id: string } }>("/api/imports/:id/assign", async (request, reply) => {
    const parsed = applySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Выберите проверенные строки плана и введите шаблон комментария." });

    try {
      const yougile = await getUserYougileClient(prisma, request.sessionUser?.id, { retryOnRateLimit: true });
      const prepared = await prepareImportAssignment(request.params.id, parsed.data, yougile);
      const operation = await prisma.$transaction(async (transaction) => {
        const batchStatus = await transaction.importBatch.updateMany({
          where: { id: prepared.batchId, status: ImportBatchStatus.PREVIEW },
          data: { status: ImportBatchStatus.ASSIGNING }
        });
        if (batchStatus.count !== 1) {
          throw new AssignmentValidationError("Эта загрузка уже обрабатывается. Обновите страницу.");
        }

        return transaction.operation.create({
          data: {
            type: OperationType.ASSIGN,
            status: OperationStatus.QUEUED,
            // Автор операции: по нему считается статистика сотрудников в админке.
            createdById: request.sessionUser?.id ?? null,
            total: prepared.items.length,
            metadata: {
              importBatchId: prepared.batchId,
              fileName: prepared.fileName,
              workType: parsed.data.workType,
              commentTemplate: parsed.data.commentTemplate
            },
            items: {
              create: prepared.items.map((item) => ({
                importRowId: item.importRowId,
                siteId: item.siteId,
                requestedUserId: item.userId,
                beforeData: {
                  taskId: item.taskId,
                  title: item.address ?? item.siteId,
                  assignedUserIds: item.currentUserIds,
                  importRowNumber: item.rowNumber,
                  engineerName: item.engineerName,
                  commentText: item.comment
                }
              }))
            }
          }
        });
      });

      try {
        await operationQueue.add("assign-engineer", { operationId: operation.id }, { jobId: operation.id });
      } catch (error) {
        await prisma.operation.update({
          where: { id: operation.id },
          data: { status: OperationStatus.FAILED, message: "Не удалось поставить операцию в очередь.", finishedAt: new Date() }
        });
        await prisma.importBatch.update({
          where: { id: prepared.batchId },
          data: { status: ImportBatchStatus.PREVIEW }
        });
        throw error;
      }

      return reply.code(202).send({ operationId: operation.id });
    } catch (error) {
      if (error instanceof UserYougileCredentialError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof AssignmentValidationError) return reply.code(400).send({ error: error.message });
      app.log.error({ err: error }, "Could not enqueue XLSX assignment operation");
      return reply.code(502).send({ error: "Не удалось запустить назначение из XLSX. Изменения не применены." });
    }
  });
}
