import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { YougileClient } from "../../integrations/yougile/client.js";
import { operationQueue } from "../../jobs/queue.js";
import { getAssignmentUsers } from "../users/service.js";
import {
  assignmentPreviewBodySchema,
  AssignmentValidationError,
  previewAssignments
} from "./service.js";

export async function registerAssignmentRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  yougile: YougileClient
) {
  app.get("/api/users", async (_request, reply) => {
    try {
      const items = await getAssignmentUsers(yougile);
      return { items, count: items.length };
    } catch (error) {
      app.log.error({ err: error }, "Could not load YouGile users");
      return reply.code(502).send({ error: "Не удалось загрузить сотрудников из YouGile." });
    }
  });

  app.post("/api/assignments/preview", async (request, reply) => {
    const parsed = assignmentPreviewBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Выберите от 1 до 50 уникальных площадок и одного инженера." });
    }

    try {
      return await previewAssignments(yougile, parsed.data);
    } catch (error) {
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
      include: { items: { orderBy: { createdAt: "asc" } } }
    });
    if (!operation) return reply.code(404).send({ error: "Операция не найдена." });
    if (operation.type !== "ASSIGN" && operation.type !== "REMOVE") {
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
      items: operation.items.map((item) => ({
        siteId: item.siteId,
        status: item.status,
        errorMessage: item.errorMessage
      }))
    };
  });

  app.post("/api/assignments", async (request, reply) => {
    const parsed = assignmentPreviewBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Некорректные данные назначения." });
    }

    try {
      const preview = await previewAssignments(yougile, parsed.data);
      const operation = await prisma.operation.create({
        data: {
          type: "ASSIGN",
          status: "QUEUED",
          total: preview.items.length,
          metadata: { targetUserId: preview.user.id, targetUserName: preview.user.name },
          items: {
            create: preview.items.map((item) => ({
              siteId: item.siteNumber,
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
      if (error instanceof AssignmentValidationError) {
        return reply.code(400).send({ error: error.message });
      }
      app.log.error({ err: error }, "Could not enqueue assignment operation");
      return reply.code(502).send({ error: "Не удалось подготовить назначение. Изменения не применены." });
    }
  });
}
