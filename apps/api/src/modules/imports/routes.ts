import multipart from "@fastify/multipart";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { ImportBatchStatus, ImportRowStatus, OperationStatus, OperationType, PortalRole, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { config } from "../../config.js";
import { YougileClient, YougileApiError } from "../../integrations/yougile/client.js";
import { readLatestChatMessageDetailed, type ChatLatestReadResult } from "../../integrations/yougile/chat.js";
import { UserYougileCredentialError, getUserYougileClient } from "../../integrations/yougile/user-client.js";
import { operationQueue } from "../../jobs/queue.js";
import { delayBetweenYougileActions } from "../../lib/action-delay.js";
import { normalizeEngineerName } from "../../lib/engineer-name.js";
import { describeError } from "../../lib/error-details.js";
import { finishActiveWorkCheck, isActiveWorkCheckStopRequested, registerActiveWorkCheck, requestStopActiveWorkCheck, updateActiveWorkCheck } from "../../lib/active-work-checks.js";
import { beginWorkCheck, endWorkCheck } from "../../lib/yougile-activity.js";
import { annotateLog, recordLog } from "../logs/service.js";
import { previewRateLimit, rateLimitPerUser, workCheckRateLimit } from "../auth/rate-limit.js";
import { requireRole, requireWorkspaceAccess } from "../auth/service.js";
import { getAssignmentUsers } from "../users/service.js";
import {
  AssignmentValidationError,
  maxSitesPerOperation,
  previewAssignments,
  tooManySitesError
} from "../assignments/service.js";
import { importRemovalSchema, prepareImportRemoval } from "../assignments/removal.js";
import { getPlannedSites } from "../sites/service.js";
import { renderCommentTemplate, getRawField } from "./comment-template.js";
import { parsePlanWorkbook } from "./xlsx.js";
import {
  defaultWorkCheckWindowHours,
  loadWorkCheckWindowHours,
  maxWorkCheckWindowHours,
  minWorkCheckWindowHours,
  saveWorkCheckWindowHours
} from "./settings.js";

const maxStoredImports = 5;
const importRetentionLockId = 847201563;
// Пауза перед повтором чтения чата и общее число попыток в «Проверке работ».
// YouGile редко, но отвечает HTTP 429 на чтение чата: одна площадка тогда
// падает без видимой причины. Один повтор через 5 секунд сглаживает разовые
// сбои, не раздувая проверку в длинную серию ретраев. Если повтор не удался —
// площадка пропускается, как было раньше.
const workCheckRetryDelayMs = 5_000;
const workCheckReadAttempts = 2;
// Окно «Проверки работ» задаётся в «Конфигурации портала» (в часах, AppSetting)
// и подставляется в параметр since запроса к чату: вместо обхода всего чата
// по страницам читается только окно. Значение по умолчанию и границы — в
// ./settings.ts. Комментарий старше окна в проверку не попадёт.
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
    .refine((rows) => new Set(rows).size === rows.length, "Выбраны повторяющиеся строки XLSX."),
  // Идентификатор проверки от фронтенда: по нему тот опрашивает живой прогресс,
  // пока синхронный POST /work-check обрабатывает площадки в фоне.
  checkId: z.string().trim().min(1).max(64).optional()
});
const multiImportRemovalSchema = z.object({
  batches: z.array(z.object({ importId: z.string().min(1), rowNumbers: z.array(z.number().int().positive()).min(1) })).min(1)
});

// Настройка окна «Проверки работ»: сколько часов назад смотреть сообщения чата.
const workCheckSettingsSchema = z.object({
  windowHours: z.number().int()
    .min(minWorkCheckWindowHours, `Период должен быть не меньше ${minWorkCheckWindowHours} часа.`)
    .max(maxWorkCheckWindowHours, `Период не должен превышать ${maxWorkCheckWindowHours} часов.`)
});

// Живой прогресс «Проверки работ». Запрос синхронный и идёт примерно 4 секунды
// на площадку, поэтому фронтенду нужен отдельный источник правды, чтобы показать
// полосу и оценку оставшегося времени. Прогресс хранится в памяти процесса и не
// переживает рестарт API — для полосы ожидания это допустимо.
type WorkCheckProgressEntry = {
  checkId: string;
  total: number;
  processed: number;
  startedAt: number;
  finishedAt: number | null;
};
const workCheckProgress = new Map<string, WorkCheckProgressEntry>();
const workCheckProgressTtlMs = 5 * 60 * 1000;

function sweepWorkCheckProgress() {
  const now = Date.now();
  for (const [checkId, entry] of workCheckProgress) {
    // Запись удаляем и по завершению, и по возрасту начала. Второе нужно для
    // упавшей проверки: если цикл упал по исключению, finishedAt так и остался
    // null, и без проверки startedAt запись лежала бы в памяти вечно.
    const referenceTime = entry.finishedAt ?? entry.startedAt;
    if (now - referenceTime > workCheckProgressTtlMs) {
      workCheckProgress.delete(checkId);
    }
  }
}

/** Оценка времени до конца проверки по темпу уже обработанных площадок. */
function estimateWorkCheckRemainingMs(entry: WorkCheckProgressEntry): number | null {
  if (entry.finishedAt !== null) return 0;
  if (entry.total === 0 || entry.processed === 0) return null;
  const perSiteMs = (Date.now() - entry.startedAt) / entry.processed;
  // Нижняя граница: на каждую оставшуюся площадку уходит минимум сам запрос
  // (плюс пауза 4 секунды перед следующей), поэтому в начале проверки темп ещё
  // не успевает сложиться, и результат без границы был бы обманчиво маленьким.
  const remainingMs = Math.max(
    (entry.total - entry.processed) * perSiteMs,
    (entry.total - entry.processed) * 1000
  );
  return Math.round(remainingMs);
}

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
  // Значение столбца «klaster» XLSX: после назначения инженера в чат задачи
  // уходит комментарий кластера («Обрати внимание! Кластер: площадка-кластер»),
  // как в n8n-воркфлоу «Yougile - add users». null — кластера в строке нет,
  // комментарий не отправляется.
  cluster: string | null;
};

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
  const readAccess = requireWorkspaceAccess("WORK_MANAGEMENT");
  app.post<{ Params: { checkId: string } }>("/api/imports/work-check/:checkId/stop", { preHandler: readAccess }, async (request, reply) => {
    return requestStopActiveWorkCheck(request.params.checkId) ? { ok: true } : reply.code(404).send({ error: "Проверка уже завершена." });
  });
  const writeAccess = requireWorkspaceAccess("WORK_MANAGEMENT", true);
  const adminOnly = requireRole(PortalRole.ADMIN);
  await app.register(multipart, {
    limits: { fileSize: config.UPLOAD_MAX_BYTES, files: 1, fields: 0, parts: 1 }
  });

  // Настройка окна «Проверки работ». Правит только администратор — как и
  // остальные настройки «Конфигурации портала». Чтение отдельным эндпоинтом,
  // чтобы форма конфигурации не тянула весь список загрузок XLSX.
  app.get("/api/imports/work-check/settings", { preHandler: adminOnly }, async () => ({
    windowHours: await loadWorkCheckWindowHours(prisma),
    defaultWindowHours: defaultWorkCheckWindowHours,
    minWindowHours: minWorkCheckWindowHours,
    maxWindowHours: maxWorkCheckWindowHours
  }));

  app.put("/api/imports/work-check/settings", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = workCheckSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте период проверки." });
    }
    try {
      await saveWorkCheckWindowHours(prisma, parsed.data.windowHours);
    } catch (error) {
      app.log.error({ err: error }, "Could not save work check window setting");
      return reply.code(500).send({ error: "Не удалось сохранить период проверки." });
    }
    app.log.warn(
      { actor: request.sessionUser?.login, windowHours: parsed.data.windowHours },
      "Work check window updated via portal config"
    );
    return { windowHours: parsed.data.windowHours };
  });

  app.get("/api/imports", { preHandler: readAccess }, async (_request, reply) => {
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

  app.get<{ Params: { id: string } }>("/api/imports/:id", { preHandler: readAccess }, async (request, reply) => {
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

  app.post<{ Params: { id: string } }>("/api/imports/:id/work-check", { preHandler: [readAccess, rateLimitPerUser(workCheckRateLimit)] }, async (request, reply) => {
    const parsed = workCheckSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Выберите строки XLSX для проверки комментариев." });

    // Пока идёт проверка, списки площадок не перечитываются из YouGile: чтение
    // чатов и так идёт по площадке с паузой 4 секунды, а параллельный обход
    // колонок плана/АВР добавляет запросы и провоцирует HTTP 429.
    beginWorkCheck();
    const operationStartedAt = new Date();
    const activeCheckId = parsed.data.checkId ?? `wc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    registerActiveWorkCheck({
      checkId: activeCheckId,
      importId: request.params.id,
      fileName: null,
      total: parsed.data.rowNumbers.length,
      completed: 0,
      startedAt: Date.now()
    });
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
      updateActiveWorkCheck(activeCheckId, { fileName: batch.fileName, total: uniqueTaskIds.length });
      // Нижняя граница окна берётся из настройки и считается один раз на запуск,
      // чтобы все площадки проверялись по одному и тому же интервалу времени.
      const windowHours = await loadWorkCheckWindowHours(prisma);
      const since = Date.now() - windowHours * 60 * 60 * 1000;
      // timestamp — метка времени последнего сообщения из id YouGile (epoch ms),
      // уходит на фронт как commentedAt, чтобы показать, когда комментарий написан.
      const latestByTaskId = new Map<string, { text: string | null; timestamp: number | null; error: string | null }>();
      if (parsed.data.checkId) {
        sweepWorkCheckProgress();
        workCheckProgress.set(parsed.data.checkId, {
          checkId: parsed.data.checkId,
          total: uniqueTaskIds.length,
          processed: 0,
          startedAt: Date.now(),
          finishedAt: null
        });
      }
      // Чтение чатов строго по очереди, с паузой 4 секунды между площадками —
      // как записи операций: YouGile не получает пачку параллельных запросов.
      // Запрос синхронный, поэтому проверка занимает ~4 секунды на площадку.
      let suspiciousReads = 0;
      for (const taskId of uniqueTaskIds) {
        // readLatestChatMessageDetailed читает чат с фильтром since — только
        // сообщения за окно проверки. Обычно это одна страница; если за окно
        // сообщений больше сотни, чтение продолжается постранично (YouGile
        // отдаёт сообщения старыми вперёд). Диагностика каждой площадки пишется
        // в лог, чтобы видеть, где теряется последний комментарий: преждевременная
        // остановка цикла или ошибки YouGile на отдельных страницах.
        //
        // Ошибка чтения (разовый HTTP 429 и т.п.) не роняет площадку сразу:
        // ждём 5 секунд и повторяем тот же запрос один раз. Если повтор опять
        // не удался — площадка пропускается, цикл идёт дальше.
        let chatResult: ChatLatestReadResult | null = null;
        let readError: unknown = null;
        let lastAttemptError: unknown = null;
        for (let attempt = 1; attempt <= workCheckReadAttempts; attempt++) {
          try {
            chatResult = await readLatestChatMessageDetailed(yougile, taskId, since);
            readError = null;
            break;
          } catch (error) {
            readError = error;
            lastAttemptError = error;
            if (attempt < workCheckReadAttempts) {
              app.log.warn({
                err: error,
                taskId,
                attempt,
                statusCode: error instanceof YougileApiError ? error.statusCode : undefined
              }, "Work check: chat read failed, retrying in 5 seconds");
              await new Promise((resolve) => setTimeout(resolve, workCheckRetryDelayMs));
            }
          }
        }

        if (readError) {
          const error = readError;
          app.log.error({
            err: error,
            taskId,
            statusCode: error instanceof YougileApiError ? error.statusCode : undefined
          }, "Could not load latest YouGile chat message");
          const failureMessage = error instanceof YougileApiError && (error.statusCode === 401 || error.statusCode === 403)
            ? "Нет доступа к чату задачи."
            : error instanceof YougileApiError && error.statusCode === 404
              ? "Чат задачи не найден."
              : "Не удалось загрузить комментарий из YouGile.";
          latestByTaskId.set(taskId, { text: null, timestamp: null, error: failureMessage });
          void recordLog(prisma, {
            level: "ERROR",
            action: "WORK-CHECK",
            message: `Не удалось прочитать чат площадки ${taskId}: ${failureMessage}`,
            actorId: request.sessionUser?.id ?? null,
            actorLogin: request.sessionUser?.login ?? null,
            actorRole: request.sessionUser?.role ?? null,
            ip: request.ip,
            method: request.method,
            path: request.url.split("?")[0] ?? request.url,
            entityId: taskId,
            request: { taskId, statusCode: error instanceof YougileApiError ? error.statusCode : undefined, details: describeError(error) },
            error: failureMessage
          });
        } else {
          // Повтор помог — в журнал попадает строка WARN, чтобы без доступа к
          // stdout было видно, что YouGile сбоил, но проверка площадки прошла.
          if (lastAttemptError) {
            const retryErrorText = lastAttemptError instanceof YougileApiError
              ? `HTTP ${lastAttemptError.statusCode}`
              : lastAttemptError instanceof Error
                ? lastAttemptError.message
                : String(lastAttemptError);
            void recordLog(prisma, {
              level: "WARN",
              action: "WORK-CHECK",
              message: `Чтение чата площадки ${taskId} не удалось с первого раза (${retryErrorText}), повтор через 5 секунд прошёл успешно.`,
              actorId: request.sessionUser?.id ?? null,
              actorLogin: request.sessionUser?.login ?? null,
              actorRole: request.sessionUser?.role ?? null,
              ip: request.ip,
              method: request.method,
              path: request.url.split("?")[0] ?? request.url,
              entityId: taskId,
              request: {
                taskId,
                statusCode: lastAttemptError instanceof YougileApiError ? lastAttemptError.statusCode : undefined,
                details: describeError(lastAttemptError)
              }
            });
          }
          const { latest, diagnostics } = chatResult as ChatLatestReadResult;
          latestByTaskId.set(taskId, { text: latest?.text ?? null, timestamp: latest?.timestamp ?? null, error: null });
          const logData = {
            taskId,
            since: diagnostics.since,
            pagesRead: diagnostics.pagesRead,
            rawMessages: diagnostics.rawMessages,
            textMessages: diagnostics.textMessages,
            emptyTextMessages: diagnostics.emptyTextMessages,
            stopReason: diagnostics.stopReason,
            stoppedOnFullRawPage: diagnostics.stoppedOnFullRawPage,
            latestTimestamp: diagnostics.latestTimestamp,
            latestTextLength: diagnostics.latestTextLength,
            latestTextPreview: diagnostics.latestTextPreview,
            durationMs: diagnostics.durationMs
          };
          if (diagnostics.stoppedOnFullRawPage || diagnostics.stopReason === "max-pages") {
            suspiciousReads += 1;
            app.log.warn({ ...logData, pages: diagnostics.pages }, "Work check: chat read stopped suspiciously");
            // Строка в журнале сайта: администратор видит такие случаи без
            // доступа к stdout. Диагностика страниц кладётся в request.
            void recordLog(prisma, {
              level: "WARN",
              action: "WORK-CHECK",
              message: diagnostics.stopReason === "max-pages"
                ? `Чтение чата площадки ${taskId} упёрлось в лимит страниц: сообщений с текстом ${diagnostics.textMessages} из ${diagnostics.rawMessages}.`
                : `Чтение чата площадки ${taskId} остановилось на полной странице без текстовых сообщений: с текстом ${diagnostics.textMessages} из ${diagnostics.rawMessages}. Последний комментарий мог быть не дочитан.`,
              actorId: request.sessionUser?.id ?? null,
              actorLogin: request.sessionUser?.login ?? null,
              actorRole: request.sessionUser?.role ?? null,
              ip: request.ip,
              method: request.method,
              path: request.url.split("?")[0] ?? request.url,
              entityId: taskId,
              request: {
                taskId,
                pagesRead: diagnostics.pagesRead,
                rawMessages: diagnostics.rawMessages,
                textMessages: diagnostics.textMessages,
                emptyTextMessages: diagnostics.emptyTextMessages,
                stopReason: diagnostics.stopReason,
                stoppedOnFullRawPage: diagnostics.stoppedOnFullRawPage,
                pages: diagnostics.pages,
                latestTimestamp: diagnostics.latestTimestamp,
                latestTextLength: diagnostics.latestTextLength,
                latestTextPreview: diagnostics.latestTextPreview,
                durationMs: diagnostics.durationMs
              }
            });
          } else {
            app.log.info(logData, "Work check: chat read result");
          }
        }
        const progressEntry = parsed.data.checkId ? workCheckProgress.get(parsed.data.checkId) : undefined;
        if (progressEntry) progressEntry.processed += 1;
        updateActiveWorkCheck(activeCheckId, { completed: progressEntry?.processed ?? uniqueTaskIds.indexOf(taskId) + 1 });
        // Пауза 4 секунды перед чтением чата следующей площадки.
        if (!isActiveWorkCheckStopRequested(activeCheckId)) await delayBetweenYougileActions();
      }
      const progressEntry = parsed.data.checkId ? workCheckProgress.get(parsed.data.checkId) : undefined;
      if (progressEntry) progressEntry.finishedAt = Date.now();
      const stopped = isActiveWorkCheckStopRequested(activeCheckId);

      // Сводка по запуску: сколько площадок вернули комментарий, у скольких его
      // нет и какие ошибки встретились. По ней видно, систематическая ли это
      // проблема (много «noComments» при подозрительных остановках чтения) или
      // разовые сбои YouGile (коды ошибок в errorBreakdown).
      let foundComments = 0;
      let noComments = 0;
      let errors = 0;
      const errorBreakdown = new Map<string, number>();
      for (const row of batch.rows) {
        const result = row.yougileTaskId ? latestByTaskId.get(row.yougileTaskId) : undefined;
        if (result?.text) foundComments += 1;
        else if (result?.error) {
          errors += 1;
          errorBreakdown.set(result.error, (errorBreakdown.get(result.error) ?? 0) + 1);
        } else {
          noComments += 1;
        }
      }
      app.log.info({
        importId: batch.id,
        fileName: batch.fileName,
        rows: batch.rows.length,
        uniqueTasks: uniqueTaskIds.length,
        foundComments,
        noComments,
        errors,
        errorBreakdown: Object.fromEntries(errorBreakdown)
      }, "Work check run finished");
      // Строка в журнале сайта: кто и когда запускал проверку и чем она
      // закончилась. Подозрительные остановки чтения и ошибки пишутся
      // отдельными WARN/ERROR-строками по каждой площадке.
      annotateLog(request, {
        action: "WORK-CHECK",
        message: `Проверка работ «${batch.fileName}»: комментариев найдено ${foundComments}, без комментариев ${noComments}, ошибок ${errors}${suspiciousReads > 0 ? `, подозрительных остановок чтения ${suspiciousReads}` : ""}.`,
        level: errors > 0 || suspiciousReads > 0 ? "WARN" : "INFO",
        entityId: batch.id
      });

      const resultItems = batch.rows.map((row) => {
        const result = row.yougileTaskId ? latestByTaskId.get(row.yougileTaskId) : undefined;
        return {
          rowNumber: row.rowNumber,
          siteId: row.siteId,
          comment: result?.text ?? null,
          commentedAt: result?.timestamp != null ? new Date(result.timestamp).toISOString() : null,
          message: stopped && !result ? "Проверка остановлена до обработки этой площадки." : result?.error ?? (result?.text
            ? "Последний комментарий найден."
            : row.yougileTaskId ? "Комментариев за выбранный период проверки нет." : "Площадка не найдена в YouGile.")
        };
      });
      const finishedAt = new Date();
      const workCheckFailures = batch.rows.filter((row) => row.yougileTaskId && latestByTaskId.get(row.yougileTaskId)?.error).length;
      const completedRows = batch.rows.filter((row) => !row.yougileTaskId || latestByTaskId.has(row.yougileTaskId)).length;
      const operation = await prisma.operation.create({
        data: {
          type: OperationType.WORK_CHECK,
          status: stopped ? OperationStatus.CANCELLED : workCheckFailures > 0 ? OperationStatus.PARTIAL : OperationStatus.SUCCEEDED,
          createdById: request.sessionUser?.id ?? null,
          total: batch.rows.length,
          completed: stopped ? completedRows : batch.rows.length - workCheckFailures,
          failed: workCheckFailures,
          message: stopped ? `Проверка работ остановлена пользователем: обработано площадок ${latestByTaskId.size} из ${uniqueTaskIds.length}.` : `Проверка работ «${batch.fileName}»: комментариев найдено ${foundComments}, без комментариев ${noComments}, ошибок ${errors}.`,
          startedAt: operationStartedAt,
          finishedAt,
          metadata: { importBatchId: batch.id, fileName: batch.fileName },
          items: {
            create: batch.rows.map((row, index) => {
              const result = row.yougileTaskId ? latestByTaskId.get(row.yougileTaskId) : undefined;
              const item = resultItems[index]!;
              return {
                siteId: `work-check-row-${row.rowNumber}`,
                sortOrder: index,
                beforeData: { title: row.siteId ?? `Строка ${row.rowNumber}`, rowNumber: row.rowNumber },
                status: result?.error
                  ? "FAILED"
                  : result?.text
                    ? "SUCCEEDED"
                    : "SKIPPED",
                errorMessage: result?.error ?? null,
                afterData: { comment: item.comment, commentedAt: item.commentedAt, message: item.message }
              };
            })
          }
        }
      });

      return {
        operationId: operation.id,
        importId: batch.id,
        fileName: batch.fileName,
        stopped,
        items: resultItems
      };
    } catch (error) {
      if (error instanceof UserYougileCredentialError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      app.log.error({ err: error, importId: request.params.id }, "Could not check latest comments for XLSX rows");
      return reply.code(502).send({ error: "Не удалось проверить комментарии по выбранному XLSX." });
    } finally {
      endWorkCheck();
      finishActiveWorkCheck(activeCheckId);
    }
  });

  app.get<{ Querystring: { checkId?: string } }>("/api/imports/work-check/progress", { preHandler: readAccess }, async (request) => {
    const checkId = request.query.checkId;
    const entry = checkId ? workCheckProgress.get(checkId) : undefined;
    if (!entry) {
      // Проверка ещё не зарегистрировалась (запрос только стартовал) или не
      // существует — фронтенд показывает «подготавливаем» и продолжает опрос.
      return { total: 0, processed: 0, startedAt: null, finishedAt: null, remainingMs: null };
    }
    return {
      total: entry.total,
      processed: entry.processed,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      remainingMs: estimateWorkCheckRemainingMs(entry)
    };
  });

  app.post("/api/imports/preview", { preHandler: [writeAccess, rateLimitPerUser(previewRateLimit)] }, async (request, reply) => {
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

      const readyCount = rows.filter((row) => row.status === ImportRowStatus.READY).length;
      // multipart не попадает в request.body, поэтому без этой строки в журнале
      // остался бы один «POST /api/imports/preview» без имени файла и чисел.
      annotateLog(request, {
        message: `Загружен файл «${batch.fileName}»: строк в файле ${rows.length}, к назначению ${readyCount}`,
        entityId: batch.id
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

  app.get<{ Params: { id: string } }>("/api/imports/:id/problematic-sites.xlsx", { preHandler: readAccess }, async (request, reply) => {
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
          comment: renderCommentTemplate(input.commentTemplate, row.rawData),
          cluster: getRawField(row.rawData, "klaster") || null
        };
      })
    };
  }

  app.post<{ Params: { id: string } }>("/api/imports/:id/assignment-preview", { preHandler: readAccess }, async (request, reply) => {
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

  app.post<{ Params: { id: string } }>("/api/imports/:id/removal-preview", { preHandler: readAccess }, async (request, reply) => {
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

  app.post("/api/imports/removal-preview-multiple", { preHandler: readAccess }, async (request, reply) => {
    const parsed = multiImportRemovalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Выберите строки XLSX для снятия инженеров." });
    try {
      const yougile = await getUserYougileClient(prisma, request.sessionUser?.id, { retryOnRateLimit: true });
      const batches = [];
      const sites = new Set<string>();
      for (const selection of parsed.data.batches) {
        const result = await prepareImportRemoval(yougile, prisma, selection.importId, selection.rowNumbers);
        for (const item of result.items) {
          if (sites.has(item.siteId)) throw new AssignmentValidationError(`Площадка ${item.siteId} выбрана более одного раза в нескольких XLSX.`);
          sites.add(item.siteId);
          batches.push({ ...item, fileName: result.fileName });
        }
      }
      if (batches.length > maxSitesPerOperation) return reply.code(400).send({ error: tooManySitesError("площадок") });
      return { count: batches.length, willRemove: batches.filter((item) => item.willRemove).length, items: batches };
    } catch (error) {
      if (error instanceof UserYougileCredentialError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof AssignmentValidationError) return reply.code(400).send({ error: error.message });
      app.log.error({ err: error }, "Could not prepare multi-XLSX removal preview");
      return reply.code(502).send({ error: "Не удалось проверить назначения по выбранным XLSX." });
    }
  });

  app.post("/api/imports/remove-multiple", { preHandler: writeAccess }, async (request, reply) => {
    const parsed = multiImportRemovalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Выберите проверенные строки XLSX для снятия инженеров." });
    try {
      const yougile = await getUserYougileClient(prisma, request.sessionUser?.id, { retryOnRateLimit: true });
      const preparedItems = [];
      const sites = new Set<string>();
      const sourceFiles: string[] = [];
      for (const selection of parsed.data.batches) {
        const prepared = await prepareImportRemoval(yougile, prisma, selection.importId, selection.rowNumbers);
        sourceFiles.push(prepared.fileName);
        for (const item of prepared.items) {
          if (sites.has(item.siteId)) throw new AssignmentValidationError(`Площадка ${item.siteId} выбрана более одного раза в нескольких XLSX.`);
          sites.add(item.siteId);
          preparedItems.push(item);
        }
      }
      if (preparedItems.length > maxSitesPerOperation) return reply.code(400).send({ error: tooManySitesError("площадок") });
      const operation = await prisma.operation.create({
        data: {
          type: OperationType.REMOVE, status: OperationStatus.QUEUED,
          createdById: request.sessionUser?.id ?? null,
          total: preparedItems.length,
          metadata: { fileName: sourceFiles.join(", "), sourceFiles },
          items: { create: preparedItems.map((item, index) => ({
            importRowId: item.importRowId, siteId: item.siteId, sortOrder: index, requestedUserId: item.userId,
            beforeData: { taskId: item.taskId, title: item.title, assignedUserIds: item.assignedUserIds, engineerName: item.engineerName, importRowNumber: item.rowNumber }
          })) }
        }
      });
      try { await operationQueue.add("remove-engineers", { operationId: operation.id }, { jobId: operation.id }); }
      catch (error) {
        await prisma.operation.update({ where: { id: operation.id }, data: { status: OperationStatus.FAILED, message: "Не удалось добавить операцию в очередь.", finishedAt: new Date() } });
        throw error;
      }
      return reply.code(202).send({ operationId: operation.id });
    } catch (error) {
      if (error instanceof UserYougileCredentialError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof AssignmentValidationError) return reply.code(400).send({ error: error.message });
      app.log.error({ err: error }, "Could not enqueue multi-XLSX removal");
      return reply.code(502).send({ error: "Не удалось запустить снятие инженеров." });
    }
  });

  app.post<{ Params: { id: string } }>("/api/imports/:id/remove", { preHandler: writeAccess }, async (request, reply) => {
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
            create: prepared.items.map((item, index) => ({
              importRowId: item.importRowId,
              siteId: item.siteId,
              sortOrder: index,
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

  app.post<{ Params: { id: string } }>("/api/imports/:id/assign", { preHandler: writeAccess }, async (request, reply) => {
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
              create: prepared.items.map((item, index) => ({
                importRowId: item.importRowId,
                siteId: item.siteId,
                sortOrder: index,
                requestedUserId: item.userId,
                beforeData: {
                  taskId: item.taskId,
                  title: item.address ?? item.siteId,
                  assignedUserIds: item.currentUserIds,
                  importRowNumber: item.rowNumber,
                  engineerName: item.engineerName,
                  commentText: item.comment,
                  cluster: item.cluster
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
