import { OperationItemStatus, OperationStatus, OperationType, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { config } from "../../config.js";
import { YougileApiError, YougileClient } from "../../integrations/yougile/client.js";
import { postChatMessage } from "../../integrations/yougile/chat.js";
import type { OperationJob } from "../../jobs/queue.js";
import { delayBetweenYougileActions } from "../../lib/action-delay.js";
import { describeError } from "../../lib/error-details.js";
import { getPlannedSites, type PlannedSite } from "../sites/service.js";
import { getAssignmentUsers } from "../users/service.js";

const taskDetailsSchema = z.object({
  id: z.string(),
  title: z.string(),
  columnId: z.string(),
  assigned: z.array(z.string()).nullable().optional(),
  archived: z.boolean().nullable().optional(),
  deleted: z.boolean().nullable().optional(),
  completed: z.boolean().nullable().optional()
});

// Лимита площадок на операцию нет: назначение упирается только в последовательную
// очередь. 2000 — аварийный предохранитель, тот же, что в модуле комментариев.
export const maxSitesPerOperation = 2000;

// Общее сообщение о переполнении, чтобы лимит звучал одинаково во всех схемах.
export function tooManySitesError(what: string) {
  return `За один запуск можно выбрать не больше ${maxSitesPerOperation.toLocaleString("ru-RU")} ${what}. Разбейте операцию на части.`;
}

const previewInputSchema = z.object({
  taskIds: z.array(z.string().uuid()).min(1).max(maxSitesPerOperation, tooManySitesError("площадок"))
    .refine((ids) => new Set(ids).size === ids.length, "Выбраны повторяющиеся задачи."),
  userId: z.string().uuid()
});

export type AssignmentPreviewInput = z.infer<typeof previewInputSchema>;
export type TaskDetails = z.infer<typeof taskDetailsSchema>;

export class AssignmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssignmentValidationError";
  }
}

function toTaskDetails(value: unknown, taskId: string): TaskDetails {
  const parsed = taskDetailsSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== taskId) {
    throw new Error("Не удалось проверить текущее состояние задачи в YouGile.");
  }
  return parsed.data;
}

export async function readTask(client: YougileClient, taskId: string): Promise<TaskDetails> {
  return toTaskDetails(await client.request(`tasks/${encodeURIComponent(taskId)}`), taskId);
}

async function assignTaskUsers(client: YougileClient, taskId: string, userIds: string[]) {
  const request = () => client.request(`tasks/${encodeURIComponent(taskId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assigned: userIds })
  });

  try {
    await request();
  } catch (error) {
    if (!(error instanceof YougileApiError) || error.statusCode !== 400) throw error;
    await delayBetweenYougileActions();
    await request();
  }
}

export function validatePlanTask(task: TaskDetails, siteByTaskId: Map<string, PlannedSite>): PlannedSite {
  const plannedSite = siteByTaskId.get(task.id);
  if (
    !plannedSite ||
    task.columnId !== config.YOUGILE_PLAN_COLUMN_ID ||
    task.archived ||
    task.deleted ||
    plannedSite.siteNumber !== task.title.match(/^(\d+)/)?.[1]
  ) {
    throw new AssignmentValidationError("Задача больше не находится в активном плане. Обновите список площадок.");
  }
  return plannedSite;
}

export async function previewAssignments(
  client: YougileClient,
  input: AssignmentPreviewInput
) {
  const users = await getAssignmentUsers(client);
  const user = users.find((candidate) => candidate.id === input.userId);
  if (!user) throw new AssignmentValidationError("Выбранный инженер не найден среди пользователей YouGile.");

  const plannedSites = await getPlannedSites(client);
  const siteByTaskId = new Map(plannedSites.map((site) => [site.taskId, site]));
  const missingTask = input.taskIds.find((taskId) => !siteByTaskId.has(taskId));
  if (missingTask) {
    throw new AssignmentValidationError("Одна из выбранных задач отсутствует в актуальном плане. Обновите страницу.");
  }

  const items = [];
  for (const taskId of input.taskIds) {
    const task = await readTask(client, taskId);
    const plannedSite = validatePlanTask(task, siteByTaskId);
    const currentUserIds = task.assigned ?? [];
    items.push({
      taskId,
      siteNumber: plannedSite.siteNumber,
      title: task.title,
      currentUserIds,
      alreadyAssigned: currentUserIds.includes(user.id),
      valid: true
    });
  }

  return { user, items };
}

function assignmentFailureMessage(error: unknown, phase: "assignment" | "comment"): string {
  if (error instanceof YougileApiError) {
    const action = phase === "comment" ? "отправку комментария" : "изменение назначения";
    if (error.statusCode === 401 || error.statusCode === 403) return `YouGile отклонил ${action}: проверьте права токена.`;
    if (error.statusCode === 404) return phase === "comment"
      ? "Задача найдена, но чат задачи недоступен для комментария."
      : "Задача больше не найдена в YouGile.";
    if (error.statusCode === 400 && error.apiMessage) {
      const detail = error.apiMessage.replace(/[.!?]+$/, "");
      return `YouGile отклонил ${action} (HTTP 400): ${detail}.`;
    }
    return `YouGile отклонил ${action} (HTTP ${error.statusCode}).`;
  }
  return phase === "comment"
    ? "Инженер назначен, но комментарий не удалось отправить. Проверьте чат задачи в YouGile."
    : "Не удалось обновить задачу в YouGile. Проверьте соединение и повторите попытку.";
}

export async function processAssignmentOperation(
  prisma: PrismaClient,
  client: YougileClient,
  { operationId }: OperationJob
) {
  const operation = await prisma.operation.findUnique({
    where: { id: operationId },
    include: { items: { orderBy: { sortOrder: "asc" } } }
  });
  if (!operation || operation.type !== OperationType.ASSIGN) {
    throw new Error(`Assignment operation ${operationId} was not found`);
  }
  if (operation.status === OperationStatus.SUCCEEDED || operation.status === OperationStatus.PARTIAL) return;

  const metadata = operation.metadata;
  const fallbackComment = metadata && typeof metadata === "object" && !Array.isArray(metadata) &&
    "comment" in metadata && typeof metadata.comment === "string"
    ? metadata.comment.trim()
    : "";
  const commentsRequested = fallbackComment.length > 0 ||
    Boolean(metadata && typeof metadata === "object" && !Array.isArray(metadata) &&
      "commentTemplate" in metadata && typeof metadata.commentTemplate === "string" &&
      metadata.commentTemplate.trim());

  await prisma.operation.update({
    where: { id: operationId },
    data: { status: OperationStatus.RUNNING, startedAt: new Date() }
  });

  const siteByTaskId = new Map((await getPlannedSites(client)).map((site) => [site.taskId, site]));
  for (const item of operation.items) {
    if (item.status === OperationItemStatus.SUCCEEDED || item.status === OperationItemStatus.SKIPPED) continue;

      const taskIdValue = item.beforeData && typeof item.beforeData === "object" && "taskId" in item.beforeData
        ? item.beforeData.taskId
        : null;
      const userId = item.requestedUserId;
      const storedComment = item.beforeData && typeof item.beforeData === "object" &&
        !Array.isArray(item.beforeData) && "commentText" in item.beforeData &&
        typeof item.beforeData.commentText === "string"
        ? item.beforeData.commentText
        : fallbackComment;
      const commentText = storedComment.trim();
      let status: OperationItemStatus = OperationItemStatus.FAILED;
      let beforeData: object | undefined;
      let afterData: object | undefined;
      let errorMessage: string | undefined;
      let phase: "assignment" | "comment" = "assignment";

      try {
        if (typeof taskIdValue !== "string" || !userId) {
          throw new Error("В операции отсутствуют данные задачи или инженера.");
        }

        const task = await readTask(client, taskIdValue);
        const plannedSite = validatePlanTask(task, siteByTaskId);
        if (plannedSite.siteNumber !== item.siteId) {
          throw new Error("Номер площадки изменился после предпросмотра.");
        }

        const assigned = task.assigned ?? [];
        beforeData = { taskId: task.id, title: task.title, assignedUserIds: assigned, commentText };
        let engineerAssigned = false;
        if (assigned.includes(userId)) {
          status = commentText ? OperationItemStatus.SUCCEEDED : OperationItemStatus.SKIPPED;
          afterData = { taskId: task.id, title: task.title, assignedUserIds: assigned, commentPosted: false };
        } else {
          const nextAssigned = [...new Set([...assigned, userId])];
          await assignTaskUsers(client, task.id, nextAssigned);
          engineerAssigned = true;
          status = OperationItemStatus.SUCCEEDED;
          afterData = { taskId: task.id, title: task.title, assignedUserIds: nextAssigned, commentPosted: false };
        }

        // Пауза 2 секунды после каждой записи в YouGile: после назначения перед
        // комментарием (YouGile должен успеть применить назначение) и после
        // комментария перед следующей площадкой. При повторном запуске, когда
        // инженер уже на площадке, назначать нечего — комментарий всё равно идёт
        // с той же паузой, иначе повторная операция выстреливает серией запросов
        // за минуту и «очередь» нарушается.
        if (engineerAssigned) {
          await delayBetweenYougileActions();
        }

        if (commentText) {
          phase = "comment";
          await postChatMessage(client, task.id, commentText);
          afterData = { ...afterData, commentPosted: true };
          await delayBetweenYougileActions();
        }
      } catch (error) {
        status = OperationItemStatus.FAILED;
        errorMessage = assignmentFailureMessage(error, phase);
        afterData = { ...(afterData ?? {}), error: describeError(error) };
        console.error("Assignment item failed", {
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
        ...(status === OperationItemStatus.FAILED
          ? { failed: { increment: 1 } }
          : {}),
        message: "Операция выполняется."
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
        ? commentsRequested ? "Назначение и комментарии завершены." : "Назначение завершено."
        : `Не удалось обновить площадки: ${failed} из ${operation.total}.`,
      finishedAt: new Date()
    }
  });

  if (metadata && typeof metadata === "object" && "importBatchId" in metadata && typeof metadata.importBatchId === "string") {
    await prisma.importBatch.updateMany({
      where: { id: metadata.importBatchId },
      data: { status: "COMPLETE" }
    });
  }
}

export const assignmentPreviewBodySchema = previewInputSchema;
