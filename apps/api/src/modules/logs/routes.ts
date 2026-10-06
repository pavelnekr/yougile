import type { FastifyInstance } from "fastify";
import { PortalRole, type Prisma, type PortalLog, type PrismaClient } from "@prisma/client";
import { requireRole } from "../auth/service.js";
import { logsQuerySchema } from "./schema.js";

/**
 * Журнал действий. Доступ только для роли ADMIN: строки содержат IP-адреса,
 * тексты запросов и причины отказов, и операторам это показывать не нужно —
 * своя история операций у них есть в разделе «История».
 */
function publicLog(row: PortalLog) {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    level: row.level,
    action: row.action,
    message: row.message,
    actorLogin: row.actorLogin,
    actorRole: row.actorRole,
    ip: row.ip,
    method: row.method,
    path: row.path,
    status: row.status,
    durationMs: row.durationMs,
    request: row.request,
    error: row.error,
    entityId: row.entityId
  };
}

export async function registerLogRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const adminOnly = requireRole(PortalRole.ADMIN);

  app.get("/api/logs", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = logsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Некорректные параметры журнала." });

    const { level, actor, action, q, limit, before } = parsed.data;
    const where: Prisma.PortalLogWhereInput = {};
    if (level) where.level = level;
    if (actor) where.actorLogin = { equals: actor, mode: "insensitive" };
    if (action) where.action = action;
    if (q) {
      where.OR = [
        { message: { contains: q, mode: "insensitive" } },
        { path: { contains: q, mode: "insensitive" } },
        { action: { contains: q, mode: "insensitive" } },
        { error: { contains: q, mode: "insensitive" } },
        { actorLogin: { contains: q, mode: "insensitive" } }
      ];
    }

    try {
      const [rows, total, actorGroups, actionGroups] = await Promise.all([
        prisma.portalLog.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          // На одну строку больше, чем запрошено: лишняя выдаёт наличие
          // следующей страницы без второго запроса.
          take: limit + 1,
          ...(before ? { cursor: { id: before }, skip: 1 } : {})
        }),
        prisma.portalLog.count({ where }),
        // Списки для выпадающих фильтров считаются без условий выборки:
        // иначе выбранный фильтр прятал бы из списка все остальные значения,
        // и снять его было бы не с чего.
        prisma.portalLog.groupBy({
          by: ["actorLogin"],
          where: { actorLogin: { not: null } },
          orderBy: { actorLogin: "asc" },
          take: 100,
          _count: { _all: true }
        }),
        prisma.portalLog.groupBy({
          by: ["action"],
          orderBy: { action: "asc" },
          take: 200,
          _count: { _all: true }
        })
      ]);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;

      return {
        items: items.map(publicLog),
        total,
        hasMore,
        actors: actorGroups
          .filter((group) => group.actorLogin !== null)
          .map((group) => ({ login: group.actorLogin as string, count: group._count._all })),
        actions: actionGroups.map((group) => ({ action: group.action, count: group._count._all }))
      };
    } catch (error) {
      app.log.error({ err: error }, "Could not load portal log");
      return reply.code(500).send({ error: "Не удалось загрузить журнал действий." });
    }
  });
}
