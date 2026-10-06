import type { FastifyInstance } from "fastify";
import { OperationStatus, OperationType, PrismaClient } from "@prisma/client";
import { UserYougileCredentialError, getUserYougileClient } from "../../integrations/yougile/user-client.js";
import { operationQueue } from "../../jobs/queue.js";
import { getAssignmentUsers } from "../users/service.js";
import {
  assignmentPreviewBodySchema,
  AssignmentValidationError,
  previewAssignments
} from "./service.js";

const visibleOperationTypes: OperationType[] = [
  OperationType.ASSIGN,
  OperationType.REMOVE,
  OperationType.COMMENT
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
  app.get("/api/users", async (request, reply) => {
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

  app.post("/api/assignments/preview", async (request, reply) => {
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

  app.get<{ Params: { id: string } }>("/api/operations/:id", async (request, reply) => {
    const operation = await prisma.operation.findUnique({
      where: { id: request.params.id },
      include: { items: { orderBy: { sortOrder: "asc" } } }
    });
    if (!operation) return reply.code(404).send({ error: "Операция не найдена." });
    if (!visibleOperationTypes.includes(operation.type)) {
      return reply.code(400).send({ error: "Неизвестный тип операции." });
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
        details: errorDetailsFrom(item.afterData)
      }))
    };
  });

  // Активные операции для панели «Идёт операция» на обзоре. Сводка без строк:
  // детальный список площадок страница получает по GET /api/operations/:id,
  // когда открывает операцию. Операция активна, пока стоит в очереди или
  // выполняется воркером в фоне.
  app.get("/api/operations/active", async () => {
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

    return {
      items: operations
        .filter((operation) => visibleOperationTypes.includes(operation.type))
        .map((operation) => ({
          id: operation.id,
          type: operation.type,
          status: operation.status,
          total: operation.total,
          completed: operation.completed,
          failed: operation.failed,
          message: operation.message
        }))
    };
  });

  app.post("/api/assignments", async (request, reply) => {
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
