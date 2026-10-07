import { OperationItemStatus, OperationStatus, OperationType, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { YougileApiError, YougileClient } from "../../integrations/yougile/client.js";
import { readLatestChatMessage, postChatMessage } from "../../integrations/yougile/chat.js";
import type { OperationJob } from "../../jobs/queue.js";
import { delayBetweenYougileActions } from "../../lib/action-delay.js";
import { describeError } from "../../lib/error-details.js";
import { getPlannedSites } from "../sites/service.js";
import { getAssignmentUsers } from "../users/service.js";
import { AssignmentValidationError, readTask, validatePlanTask } from "../assignments/service.js";
import { commentTemplateTypeSchema } from "../settings/schema.js";

// Лимита площадок на операцию нет: комментарии пишутся в чаты, а не меняют назначения.
// 2000 — аварийный предохранитель, чтобы один запрос не занял очередь на сутки.
const maxCommentedSites = 2000;
// Параллельных чтений задач внутри предпросмотра.
const previewConcurrency = 5;

const taskIdSchema = z.string({
  required_error: "Передайте идентификатор площадки.",
  invalid_type_error: "Идентификатор площадки должен быть строкой."
}).uuid("Идентификатор площадки передан в неверном формате.");

const commentInputSchema = z.object({
  taskIds: z.array(taskIdSchema)
    .min(1, "Выберите хотя бы одну площадку.")
    .max(maxCommentedSites, `За один запуск можно выбрать не больше ${maxCommentedSites.toLocaleString("ru-RU")} площадок.`)
    .refine((ids) => new Set(ids).size === ids.length, "Выбраны повторяющиеся площадки."),
  comment: z.string({
    required_error: "Введите текст комментария.",
    invalid_type_error: "Текст комментария должен быть строкой."
  }).trim().min(1, "Введите текст комментария.").max(10_000, "Комментарий не должен превышать 10 000 символов."),
  // Какой шаблон из настроек был использован — пишется в журнал операции.
  commentTemplate: commentTemplateTypeSchema.optional()
});

export type CommentInput = z.infer<typeof commentInputSchema>;
export const commentRequestBodySchema = commentInputSchema;

export type CommentPreviewItem = {
  taskId: string;
  siteNumber: string;
  title: string;
  currentEngineers: { id: string; name: string }[];
  lastComment: string | null;
  lastCommentAt: string | null;
  lastCommentError: string | null;
};

function describeChatError(error: unknown) {
  if (error instanceof YougileApiError) {
    if (error.statusCode === 401 || error.statusCode === 403) return "Нет доступа к чату задачи.";
    if (error.statusCode === 404) return "Чат задачи не найден.";
  }
  return "Не удалось прочитать последний комментарий из YouGile.";
}

/**
 * Предпросмотр перечитывает каждую задачу из YouGile заново: площадка могла уйти
 * из плана, а чат — получить новые сообщения с момента загрузки страницы.
 */
export async function previewComments(client: YougileClient, input: CommentInput) {
  const [plannedSites, employees] = await Promise.all([
    getPlannedSites(client),
    getAssignmentUsers(client)
  ]);
  const siteByTaskId = new Map(plannedSites.map((site) => [site.taskId, site]));
  const nameByUserId = new Map(employees.map((user) => [user.id, user.name]));

  const missingTask = input.taskIds.find((taskId) => !siteByTaskId.has(taskId));
  if (missingTask) {
    throw new AssignmentValidationError("Одна из выбранных площадок отсутствует в актуальном плане. Обновите список площадок.");
  }

  const items: CommentPreviewItem[] = [];
  for (let index = 0; index < input.taskIds.length; index += previewConcurrency) {
    const batch = input.taskIds.slice(index, index + previewConcurrency);
    const batchItems = await Promise.all(batch.map(async (taskId): Promise<CommentPreviewItem> => {
      const task = await readTask(client, taskId);
      const plannedSite = validatePlanTask(task, siteByTaskId);
      let lastComment: string | null = null;
      let lastCommentAt: string | null = null;
      let lastCommentError: string | null = null;
      try {
        const latest = await readLatestChatMessage(client, taskId);
        lastComment = latest?.text ?? null;
        lastCommentAt = latest?.timestamp !== null && latest?.timestamp !== undefined
          ? new Date(latest.timestamp).toISOString()
          : null;
      } catch (error) {
        // Чат может быть закрыт, но комментарий в него всё равно отправится.
        // Поэтому ошибка чтения не блокирует предпросмотр.
        lastCommentError = describeChatError(error);
      }
      return {
        taskId,
        siteNumber: plannedSite.siteNumber,
        title: task.title,
        currentEngineers: (task.assigned ?? []).map((id) => ({ id, name: nameByUserId.get(id) ?? "Сотрудник не найден" })),
        lastComment,
        lastCommentAt,
        lastCommentError
      };
    }));
    items.push(...batchItems);
  }

  return { comment: input.comment, count: items.length, items };
}

function commentFailureMessage(error: unknown) {
  if (error instanceof YougileApiError) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return "YouGile отклонил отправку комментария: проверьте права токена.";
    }
    if (error.statusCode === 404) return "Задача найдена, но чат задачи недоступен для комментария.";
    return `YouGile отклонил отправку комментария (HTTP ${error.statusCode}).`;
  }
  return "Не удалось отправить комментарий в YouGile. Проверьте соединение и повторите попытку.";
}

function jsonString(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !(key in value)) return null;
  const result = (value as Record<string, unknown>)[key];
  return typeof result === "string" ? result : null;
}

export async function processCommentOperation(
  prisma: PrismaClient,
  client: YougileClient,
  { operationId }: OperationJob
) {
  const operation = await prisma.operation.findUnique({
    where: { id: operationId },
    include: { items: { orderBy: { sortOrder: "asc" } } }
  });
  if (!operation || operation.type !== OperationType.COMMENT) {
    throw new Error(`Comment operation ${operationId} was not found`);
  }
  if (operation.status === OperationStatus.SUCCEEDED || operation.status === OperationStatus.PARTIAL) return;

  const comment = (jsonString(operation.metadata, "comment") ?? "").trim();
  if (!comment) throw new Error("Comment operation has no text to send");

  await prisma.operation.update({
    where: { id: operationId },
    data: { status: OperationStatus.RUNNING, startedAt: new Date() }
  });

  const siteByTaskId = new Map((await getPlannedSites(client)).map((site) => [site.taskId, site]));
  // Комментарии отправляются строго по очереди, с паузой 4 секунды между
  // площадками, как и остальные записи в YouGile. Параллельная отправка
  // (раньше — 3 воркера) давала трекеру пачку запросов разом и ломала
  // порядок сообщений в чатах.
  for (const item of operation.items) {
    if (item.status === OperationItemStatus.SUCCEEDED || item.status === OperationItemStatus.SKIPPED) continue;

    const taskId = jsonString(item.beforeData, "taskId");
    let status: OperationItemStatus = OperationItemStatus.FAILED;
    let beforeData: object | undefined;
    let afterData: object | undefined;
    let errorMessage: string | undefined;

    try {
      if (!taskId) throw new Error("В операции отсутствует идентификатор задачи.");

      const task = await readTask(client, taskId);
      const plannedSite = validatePlanTask(task, siteByTaskId);
      if (plannedSite.siteNumber !== item.siteId) {
        throw new Error("Номер площадки изменился после предпросмотра.");
      }

      beforeData = { taskId: task.id, title: task.title, commentText: comment };
      await postChatMessage(client, task.id, comment);
      status = OperationItemStatus.SUCCEEDED;
      afterData = { taskId: task.id, title: task.title, commentPosted: true };
      // Пауза 4 секунды перед отправкой комментария на следующую площадку.
      await delayBetweenYougileActions();
    } catch (error) {
      status = OperationItemStatus.FAILED;
      errorMessage = commentFailureMessage(error);
      afterData = { ...(afterData ?? {}), error: describeError(error) };
      console.error("Comment item failed", {
        operationId,
        siteId: item.siteId,
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }

    await prisma.operationItem.update({
      where: { id: item.id },
      data: {
        status,
        attempts: { increment: 1 },
        beforeData,
        afterData,
        errorMessage,
        completedAt: new Date()
      }
    });

    await prisma.operation.update({
      where: { id: operationId },
      data: {
        completed: { increment: 1 },
        ...(status === OperationItemStatus.FAILED ? { failed: { increment: 1 } } : {}),
        message: "Комментарии отправляются в YouGile."
      }
    });
  }

  const results = await prisma.operationItem.findMany({ where: { operationId } });
  const failed = results.filter((item) => item.status === OperationItemStatus.FAILED).length;
  const completed = results.filter((item) =>
    item.status === OperationItemStatus.SUCCEEDED ||
    item.status === OperationItemStatus.SKIPPED ||
    item.status === OperationItemStatus.FAILED
  ).length;
  const status = failed === 0
    ? OperationStatus.SUCCEEDED
    : failed === completed
      ? OperationStatus.FAILED
      : OperationStatus.PARTIAL;

  await prisma.operation.update({
    where: { id: operationId },
    data: {
      status,
      completed,
      failed,
      message: failed === 0
        ? `Комментарии отправлены: ${operation.total}.`
        : `Не удалось отправить комментарии: ${failed} из ${operation.total}.`,
      finishedAt: new Date()
    }
  });
}