import type { FastifyInstance } from "fastify";
import { OperationType, PrismaClient } from "@prisma/client";
import { UserYougileCredentialError, getUserYougileClient } from "../../integrations/yougile/user-client.js";
import { operationQueue } from "../../jobs/queue.js";
import { AssignmentValidationError } from "../assignments/service.js";
import { commentRequestBodySchema, previewComments } from "./service.js";

export async function registerCommentRoutes(
  app: FastifyInstance,
  prisma: PrismaClient
) {
  app.post("/api/comments/preview", async (request, reply) => {
    const parsed = commentRequestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? "Выберите площадки и введите текст комментария."
      });
    }

    try {
      const yougile = await getUserYougileClient(prisma, request.sessionUser?.id);
      return await previewComments(yougile, parsed.data);
    } catch (error) {
      if (error instanceof UserYougileCredentialError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof AssignmentValidationError) {
        return reply.code(400).send({ error: error.message });
      }
      app.log.error({ err: error }, "Could not prepare comment preview");
      return reply.code(502).send({ error: "Не удалось проверить задачи в YouGile. Комментарии не отправлены." });
    }
  });

  app.post("/api/comments", async (request, reply) => {
    const parsed = commentRequestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? "Некорректные данные комментария."
      });
    }

    try {
      const yougile = await getUserYougileClient(prisma, request.sessionUser?.id);
      // Запись в YouGile разрешена только после предпросмотра, поэтому задачи
      // перечитываются заново и здесь, а не берутся из тела запроса.
      const preview = await previewComments(yougile, parsed.data);
      const operation = await prisma.operation.create({
        data: {
          type: OperationType.COMMENT,
          status: "QUEUED",
          // Автор операции: по нему считается статистика сотрудников в админке.
          createdById: request.sessionUser?.id ?? null,
          total: preview.count,
          metadata: {
            comment: preview.comment,
            commentTemplate: parsed.data.commentTemplate
          },
          items: {
            create: preview.items.map((item) => ({
              siteId: item.siteNumber,
              beforeData: {
                taskId: item.taskId,
                title: item.title,
                commentText: preview.comment
              }
            }))
          }
        }
      });

      try {
        await operationQueue.add("post-comments", { operationId: operation.id }, { jobId: operation.id });
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
      app.log.error({ err: error }, "Could not enqueue comment operation");
      return reply.code(502).send({ error: "Не удалось подготовить отправку комментариев. Изменения не применены." });
    }
  });
}