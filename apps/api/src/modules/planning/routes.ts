import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { PortalRole } from "@prisma/client";
import { requireRole } from "../auth/service.js";
import { listPlanRows, createPlanRow, updatePlanRow, deletePlanRow } from "./service.js";

/** Проверка прав на редактирование: OPERATOR и ADMIN могут, VIEWER — только чтение. */
const canEdit = requireRole(PortalRole.ADMIN, PortalRole.OPERATOR);

export async function registerPlanningRoutes(app: FastifyInstance, prisma: PrismaClient) {
  // Список строк с фильтрами и опциями для чипов
  app.get("/api/planning/rows", async (request) => {
    const result = await listPlanRows(prisma, request.query as Record<string, unknown>);
    return result;
  });

  // Создать строку
  app.post("/api/planning/rows", { preHandler: canEdit }, async (request, reply) => {
    try {
      const userId = request.sessionUser?.id ?? null;
      const row = await createPlanRow(prisma, request.body as Record<string, unknown>, userId);
      return reply.code(201).send(row);
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") {
        return reply.code(400).send({ error: "Некорректные данные строки.", details: error.message });
      }
      app.log.error({ err: error }, "Could not create plan row");
      return reply.code(500).send({ error: "Не удалось создать строку." });
    }
  });

  // Обновить строку (частично)
  app.patch("/api/planning/rows/:id", { preHandler: canEdit }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const row = await updatePlanRow(prisma, id, request.body as Record<string, unknown>);
      if (!row) return reply.code(404).send({ error: "Строка не найдена." });
      return row;
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") {
        return reply.code(400).send({ error: "Некорректные данные строки.", details: error.message });
      }
      app.log.error({ err: error }, "Could not update plan row");
      return reply.code(500).send({ error: "Не удалось обновить строку." });
    }
  });

  // Удалить строку
  app.delete("/api/planning/rows/:id", { preHandler: canEdit }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = await deletePlanRow(prisma, id);
    if (!ok) return reply.code(404).send({ error: "Строка не найдена." });
    return { ok: true };
  });
}