import type { FastifyInstance } from "fastify";
import { OperationStatus, OperationType, PrismaClient } from "@prisma/client";
import { UserYougileCredentialError, getUserYougileClient } from "../../integrations/yougile/user-client.js";
import { operationQueue } from "../../jobs/queue.js";
import { getActiveWorkChecks } from "../../lib/active-work-checks.js";
import { getAssignmentUsers } from "../users/service.js";
import { previewRateLimit, rateLimitPerUser } from "../auth/rate-limit.js";
import { requireWorkspaceAccess } from "../auth/service.js";
import {
  assignmentPreviewBodySchema,
  AssignmentValidationError,
  previewAssignments
} from "./service.js";

const visibleOperationTypes: OperationType[] = [
  OperationType.ASSIGN,
  OperationType.REMOVE,
  OperationType.COMMENT,
  OperationType.WORK_CHECK
];

// Название площадки для списка: для XLSX-строк это адрес (title в beforeData),
// для остальных — заголовок задачи. Нужно, когда фронтенд восстанавливает панель
// хода после ухода со страницы: предпросмотра уже нет, а адрес взять неоткуда.
function operationItemLabel(beforeData: unknown, siteId: string): string {
  if (
    beforeData &&
    typeof beforeData === "object" &&
    !Array.isArray(beforeData) &&
    "title" in beforeData &&
    typeof (beforeData as { title?: unknown }).title === "string"
  ) {
    return (beforeData as { title: string }).title;
  }
  return siteId;
}

// Структурированные детали ошибки из JSON-контейнера (afterData элемента или
// metadata операции): describeError кладёт их под ключом "error". Фронтенд
// показывает их в блоке «Диагностика для поддержки», который оператор может
// скопировать и передать разработчику.
function errorDetailsFrom(container: unknown): unknown {
  if (
    container &&
    typeof container === "object" &&
    !Array.isArray(container) &&
    "error" in container &&
    (container as { error?: unknown }).error != null
  ) {
    return (container as { error: unknown }).error;
  }
  return null;
}

export async function registerAssignmentRoutes(
  app: FastifyInstance,
  prisma: PrismaClient
) {
  const readAccess = requireWorkspaceAccess("WORK_MANAGEMENT");
  const writeAccess = requireWorkspaceAccess("WORK_MANAGEMENT", true);
  app.get("/api/users", { preHandler: readAccess }, async (request, reply) => {
    try {
      const yougile = await getUserYougileClient(prisma, request.sessionUser?.id, { retryOnRateLimit: true });
      const items = await getAssignmentUsers(yougile);
      return { items, count: items.length };
    } catch (error) {
      if (error instanceof UserYougileCredentialError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      app.log.error({ err: error }, "Could not load YouGile users");
      return reply.code(502).send({ error: "Не удалось загрузить сотрудников из YouGile." });
    }
  });

  app.post("/api/assignments/preview", { preHandler: [readAccess, rateLimitPerUser(previewRateLimit)] }, async (request, reply) => {
    const parsed = assignmentPreviewBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Выберите уникальные площадки и одного инженера." });
    }

    try {
      const yougile = await getUserYougileClient(prisma, request.sessionUser?.id, { retryOnRateLimit: true });
      return await previewAssignments(yougile, parsed.data);
    } catch (error) {
      if (error instanceof UserYougileCredentialError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof AssignmentValidationError) {
        return reply.code(400).send({ error: error.message });
      }
      app.log.error({ err: error }, "Could not prepare assignment preview");
      return reply.code(502).send({ error: "Не удалось проверить задачи в YouGile. Назначение не выполнено." });
    }
  });

  app.get<{ Params: { id: string } }>("/api/operations/:id", { preHandler: readAccess }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const operation = await prisma.operation.findUnique({
      where: { id: request.params.id },
      include: { items: { orderBy: { sortOrder: "asc" } } }
    });
    if (!operation) return reply.code(404).send({ error: "Операция не найдена." });
    if (!visibleOperationTypes.includes(operation.type)) {
      return reply.code(400).send({ error: "Неизвестный тип операции." });
    }
    if (
      operation.type === OperationType.WORK_CHECK &&
      operation.finishedAt &&
      operation.finishedAt.getTime() < Date.now() - 10 * 60 * 1000
    ) {
      return reply.code(410).send({ error: "Срок хранения результата проверки работ истёк." });
    }

    return {
      id: operation.id,
      type: operation.type,
      status: operation.status,
      total: operation.total,
      completed: operation.completed,
      failed: operation.failed,
      message: operation.message,
      errorDetails: errorDetailsFrom(operation.metadata),
      items: operation.items.map((item) => ({
        siteId: item.siteId,
        status: item.status,
        errorMessage: item.errorMessage,
        label: operationItemLabel(item.beforeData, item.siteId),
        rowNumber: item.beforeData && typeof item.beforeData === "object" && !Array.isArray(item.beforeData) && "rowNumber" in item.beforeData
          ? (item.beforeData as { rowNumber?: number }).rowNumber ?? null
          : null,
        comment: operation.type === OperationType.WORK_CHECK && item.afterData && typeof item.afterData === "object" && !Array.isArray(item.afterData) && "comment" in item.afterData
          ? (item.afterData as { comment?: string | null }).comment ?? null
          : null,
        commentedAt: operation.type === OperationType.WORK_CHECK && item.afterData && typeof item.afterData === "object" && !Array.isArray(item.afterData) && "commentedAt" in item.afterData
          ? (item.afterData as { commentedAt?: string | null }).commentedAt ?? null
          : null,
        resultMessage: operation.type === OperationType.WORK_CHECK && item.afterData && typeof item.afterData === "object" && !Array.isArray(item.afterData) && "message" in item.afterData
          ? (item.afterData as { message?: string }).message ?? null
          : null,
        details: errorDetailsFrom(item.afterData)
      }))
    };
  });

  app.get("/api/operations/recent", { preHandler: readAccess }, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    const now = new Date();
    const retainedSince = new Date(now.getTime() - 10 * 60 * 1000);
    const operations = await prisma.operation.findMany({
      where: {
        type: { in: visibleOperationTypes },
        status: { in: [OperationStatus.SUCCEEDED, OperationStatus.PARTIAL, OperationStatus.FAILED] },
        finishedAt: { gte: retainedSince }
      },
      orderBy: { finishedAt: "desc" },
      take: 50,
      select: {
        id: true,
        type: true,
        status: true,
        total: true,
        completed: true,
        failed: true,
        message: true,
        finishedAt: true,
        metadata: true
      }
    });

    return {
      items: operations.map((operation) => ({
        ...operation,
        finishedAt: operation.finishedAt?.toISOString() ?? null,
        expiresAt: operation.finishedAt
          ? new Date(operation.finishedAt.getTime() + 10 * 60 * 1000).toISOString()
          : null,
        importId: operation.type === OperationType.WORK_CHECK && operation.metadata &&
          typeof operation.metadata === "object" && !Array.isArray(operation.metadata) &&
          "importBatchId" in operation.metadata && typeof operation.metadata.importBatchId === "string"
          ? operation.metadata.importBatchId
          : null
      }))
    };
  });

  // Активные операции для панели «Идёт операция» на обзоре. Сводка без строк:
  // детальный список площадок страница получает по GET /api/operations/:id,
  // когда открывает операцию. Операция активна, пока стоит в очереди или
  // выполняется воркером в фоне.
  app.get("/api/operations/active", { preHandler: readAccess }, async () => {
    const operations = await prisma.operation.findMany({
      where: { status: { in: [OperationStatus.QUEUED, OperationStatus.RUNNING] } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        type: true,
        status: true,
        total: true,
        completed: true,
        failed: true,
        message: true
      }
    });

    const queuedItems = operations
        .filter((operation) => visibleOperationTypes.includes(operation.type))
        .map((operation) => ({
          id: operation.id,
          type: operation.type,
          status: operation.status,
          total: operation.total,
          completed: operation.completed,
          failed: operation.failed,
          message: operation.message,
          importId: null,
          fileName: null
        }));
    const workCheckItems = getActiveWorkChecks().map((check) => ({
      id: check.checkId,
      type: OperationType.WORK_CHECK,
      status: OperationStatus.RUNNING,
      total: check.total,
      completed: check.completed,
      failed: 0,
      message: check.fileName ? `Проверка работ «${check.fileName}»` : "Проверка работ",
      importId: check.importId,
      fileName: check.fileName,
      startedAt: new Date(check.startedAt).toISOString()
    }));

    return { items: [...queuedItems, ...workCheckItems] };
  });

  app.post("/api/assignments", { preHandler: writeAccess }, async (request, reply) => {
    const parsed = assignmentPreviewBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Некорректные данные назначения." });
    }

    try {
      const yougile = await getUserYougileClient(prisma, request.sessionUser?.id, { retryOnRateLimit: true });
      const preview = await previewAssignments(yougile, parsed.data);
      const operation = await prisma.operation.create({
        data: {
          type: "ASSIGN",
          status: "QUEUED",
          // Автор операции: по нему считается статистика сотрудников в админке.
          createdById: request.sessionUser?.id ?? null,
          total: preview.items.length,
          metadata: { targetUserId: preview.user.id, targetUserName: preview.user.name },
          items: {
            create: preview.items.map((item, index) => ({
              siteId: item.siteNumber,
              sortOrder: index,
              requestedUserId: preview.user.id,
              beforeData: {
                taskId: item.taskId,
                title: item.title,
                assignedUserIds: item.currentUserIds,
                engineerName: preview.user.name
              }
            }))
          }
        }
      });

      try {
        await operationQueue.add("assign-engineer", { operationId: operation.id }, { jobId: operation.id });
      } catch (error) {
        await prisma.operation.update({
          where: { id: operation.id },
          data: {
            status: "FAILED",
            message: "Не удалось поставить операцию в очередь.",
            finishedAt: new Date()
          }
        });
        throw error;
      }

      return reply.code(202).send({ operationId: operation.id });
    } catch (error) {
      if (error instanceof UserYougileCredentialError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof AssignmentValidationError) {
        return reply.code(400).send({ error: error.message });
      }
      app.log.error({ err: error }, "Could not enqueue assignment operation");
      return reply.code(502).send({ error: "Не удалось подготовить назначение. Изменения не применены." });
    }
  });
}
