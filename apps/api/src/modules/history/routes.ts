import { OperationItemStatus, OperationStatus, OperationType, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { YougileClient } from "../../integrations/yougile/client.js";
import { getAssignmentUsers } from "../users/service.js";

const historyQuerySchema = z.object({
  days: z.enum(["30", "90", "all"]).default("30"),
  page: z.coerce.number().int().min(1).default(1),
  type: z.enum(["ALL", "ASSIGN", "REMOVE", "COMMENT"]).default("ALL"),
  search: z.string().trim().max(100).default("")
});

const pageSize = 25;
// Типы операций, которые попадают в журнал и аналитику портала.
const journalTypes = [OperationType.ASSIGN, OperationType.REMOVE, OperationType.COMMENT] as const;
const operationTypeByFilter = {
  ALL: undefined,
  ASSIGN: OperationType.ASSIGN,
  REMOVE: OperationType.REMOVE,
  COMMENT: OperationType.COMMENT
} as const;
const workTypeDefinitions = [
  { type: "filter", label: "Фильтры" },
  { type: "balancers", label: "Балансеры" },
  { type: "bypasses", label: "Байпасы" },
  { type: "ehw", label: "EHW" }
] as const;

function displayName(name: string | null | undefined) {
  return name?.trim() || "Локальный оператор";
}

function stringProperty(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !(key in value)) return null;
  const result = (value as Record<string, unknown>)[key];
  return typeof result === "string" ? result : null;
}

function rangeStart(days: "30" | "90" | "all") {
  if (days === "all") return undefined;
  const date = new Date();
  date.setDate(date.getDate() - Number(days) + 1);
  date.setHours(0, 0, 0, 0);
  return date;
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function bucketKey(date: Date, days: "30" | "90" | "all") {
  if (days === "all") return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  if (days === "30") return dateKey(date);
  const monday = new Date(date);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return dateKey(monday);
}

function bucketLabel(key: string, days: "30" | "90" | "all") {
  const date = new Date(`${key}${days === "all" ? "-01" : ""}T12:00:00`);
  if (!Number.isFinite(date.getTime())) return key;
  return days === "all"
    ? date.toLocaleDateString("ru-RU", { month: "short", year: "2-digit" })
    : date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

export async function registerHistoryRoutes(app: FastifyInstance, prisma: PrismaClient, yougile: YougileClient) {
  app.get("/api/history/work-types", async (_request, reply) => {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    try {
      const operations = await prisma.operation.findMany({
        where: {
          type: OperationType.ASSIGN,
          createdAt: { gte: monthStart }
        },
        select: {
          metadata: true,
          items: { select: { status: true } }
        }
      });
      const counts = new Map(workTypeDefinitions.map(({ type }) => [type, 0]));
      let unclassified = 0;
      for (const operation of operations) {
        const successfulItems = operation.items.filter((item) => item.status === OperationItemStatus.SUCCEEDED).length;
        const workType = stringProperty(operation.metadata, "workType");
        const definition = workTypeDefinitions.find((item) => item.type === workType);
        if (definition) {
          counts.set(definition.type, (counts.get(definition.type) ?? 0) + successfulItems);
        } else {
          unclassified += successfulItems;
        }
      }
      return {
        month: `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`,
        items: workTypeDefinitions.map(({ type, label }) => ({ type, label, count: counts.get(type) ?? 0 })),
        unclassified,
        total: [...counts.values()].reduce((sum, count) => sum + count, 0) + unclassified
      };
    } catch (error) {
      app.log.error({ err: error }, "Could not load monthly work type statistics");
      return reply.code(500).send({ error: "Не удалось загрузить статистику работ за месяц." });
    }
  });

  app.get("/api/history/summary", async (request, reply) => {
    const parsed = historyQuerySchema.pick({ days: true }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Выберите период 30, 90 дней или всё время." });

    const days = parsed.data.days;
    const start = rangeStart(days);
    try {
      const [operations, imports] = await Promise.all([
        prisma.operation.findMany({
          where: start ? { createdAt: { gte: start } } : undefined,
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            type: true,
            status: true,
            total: true,
            completed: true,
            failed: true,
            createdAt: true,
            createdBy: { select: { displayName: true } },
            metadata: true,
            items: {
              select: {
                status: true,
                requestedUserId: true,
                beforeData: true,
                importRow: { select: { engineerName: true } }
              }
            }
          }
        }),
        prisma.importBatch.findMany({
          where: start ? { createdAt: { gte: start } } : undefined,
          orderBy: { createdAt: "asc" },
          select: {
            fileName: true,
            rowCount: true,
            status: true,
            createdAt: true,
            createdBy: { select: { displayName: true } }
          }
        })
      ]);
      let engineerNamesAvailable = true;
      let usersById = new Map<string, string>();
      try {
        usersById = new Map((await getAssignmentUsers(yougile)).map((user) => [user.id, user.name]));
      } catch (error) {
        engineerNamesAvailable = false;
        app.log.warn({ err: error }, "Could not resolve historical engineer names");
      }

      const activity = new Map<string, { uploads: number; assignments: number; removals: number; comments: number }>();
      const ensureBucket = (date: Date) => {
        const key = bucketKey(date, days);
        const current = activity.get(key) ?? { uploads: 0, assignments: 0, removals: 0, comments: 0 };
        activity.set(key, current);
        return current;
      };
      for (const batch of imports) ensureBucket(batch.createdAt).uploads += 1;
      for (const operation of operations) {
        const counts = ensureBucket(operation.createdAt);
        const succeeded = operation.items.filter((item) => item.status === OperationItemStatus.SUCCEEDED).length;
        if (operation.type === OperationType.ASSIGN) counts.assignments += succeeded;
        if (operation.type === OperationType.REMOVE) counts.removals += succeeded;
        if (operation.type === OperationType.COMMENT) counts.comments += succeeded;
      }

      const actors = new Map<string, { name: string; uploads: number; operations: number; assignments: number; removals: number; comments: number }>();
      const actor = (name: string | null | undefined) => {
        const label = displayName(name);
        const current = actors.get(label) ?? { name: label, uploads: 0, operations: 0, assignments: 0, removals: 0, comments: 0 };
        actors.set(label, current);
        return current;
      };
      for (const batch of imports) actor(batch.createdBy?.displayName).uploads += 1;
      for (const operation of operations) {
        const stats = actor(operation.createdBy?.displayName);
        const succeeded = operation.items.filter((item) => item.status === OperationItemStatus.SUCCEEDED).length;
        stats.operations += 1;
        if (operation.type === OperationType.ASSIGN) stats.assignments += succeeded;
        if (operation.type === OperationType.REMOVE) stats.removals += succeeded;
        if (operation.type === OperationType.COMMENT) stats.comments += succeeded;
      }

      const engineers = new Map<string, { name: string; assignments: number; removals: number }>();
      for (const operation of operations) {
        if (operation.type !== OperationType.ASSIGN && operation.type !== OperationType.REMOVE) continue;
        const metadataEngineer = stringProperty(operation.metadata, "targetUserName");
        for (const item of operation.items) {
          const name = item.importRow?.engineerName ??
            stringProperty(item.beforeData, "engineerName") ??
            metadataEngineer ??
            usersById.get(item.requestedUserId ?? "") ??
            "Инженер не указан";
          const current = engineers.get(name) ?? { name, assignments: 0, removals: 0 };
          if (operation.type === OperationType.ASSIGN && item.status === OperationItemStatus.SUCCEEDED) current.assignments += 1;
          if (operation.type === OperationType.REMOVE && item.status === OperationItemStatus.SUCCEEDED) current.removals += 1;
          engineers.set(name, current);
        }
      }

      const successfulItems = operations.reduce((sum, operation) =>
        sum + operation.items.filter((item) => item.status === OperationItemStatus.SUCCEEDED).length, 0);
      const failedItems = operations.reduce((sum, operation) =>
        sum + operation.items.filter((item) => item.status === OperationItemStatus.FAILED).length, 0);
      const pendingOperations = operations.filter((operation) =>
        operation.status === OperationStatus.QUEUED || operation.status === OperationStatus.RUNNING).length;

      return {
        period: days,
        rangeStart: start?.toISOString() ?? null,
        totals: {
          uploads: imports.length,
          uploadRows: imports.reduce((sum, batch) => sum + batch.rowCount, 0),
          operations: operations.length,
          assignmentOperations: operations.filter((operation) => operation.type === OperationType.ASSIGN).length,
          assignments: operations.filter((operation) => operation.type === OperationType.ASSIGN)
            .reduce((sum, operation) => sum + operation.items.filter((item) => item.status === OperationItemStatus.SUCCEEDED).length, 0),
          removals: operations.filter((operation) => operation.type === OperationType.REMOVE)
            .reduce((sum, operation) => sum + operation.items.filter((item) => item.status === OperationItemStatus.SUCCEEDED).length, 0),
          commentOperations: operations.filter((operation) => operation.type === OperationType.COMMENT).length,
          comments: operations.filter((operation) => operation.type === OperationType.COMMENT)
            .reduce((sum, operation) => sum + operation.items.filter((item) => item.status === OperationItemStatus.SUCCEEDED).length, 0),
          successfulItems,
          failedItems,
          pendingOperations
        },
        activity: [...activity.entries()].sort(([left], [right]) => left.localeCompare(right))
          .map(([key, values]) => ({ key, label: bucketLabel(key, days), ...values })),
        users: [...actors.values()].sort((left, right) =>
          (right.uploads + right.operations) - (left.uploads + left.operations)),
        engineers: [...engineers.values()].sort((left, right) => right.assignments - left.assignments).slice(0, 10),
        engineerNamesAvailable,
        recentUploads: imports.slice(-5).reverse().map((batch) => ({
          fileName: batch.fileName,
          rowCount: batch.rowCount,
          status: batch.status,
          createdAt: batch.createdAt.toISOString(),
          uploadedBy: displayName(batch.createdBy?.displayName)
        })),
        uploadRetentionNote: "История XLSX хранит только последние пять файлов; статистика загрузок учитывает только сохранившиеся файлы."
      };
    } catch (error) {
      app.log.error({ err: error }, "Could not load history statistics");
      return reply.code(500).send({ error: "Не удалось загрузить статистику истории." });
    }
  });

  app.get("/api/history/items", async (request, reply) => {
    const parsed = historyQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Проверьте параметры фильтра истории." });

    const { page, type, search } = parsed.data;
    const start = rangeStart(parsed.data.days);
    const selectedType = operationTypeByFilter[type];
    const where = {
      operation: {
        is: {
          ...(start ? { createdAt: { gte: start } } : {}),
          type: selectedType ?? { in: [...journalTypes] }
        }
      },
      ...(search ? {
        OR: [
          { siteId: { contains: search, mode: "insensitive" as const } },
          { importRow: { is: { engineerName: { contains: search, mode: "insensitive" as const } } } },
          { importRow: { is: { address: { contains: search, mode: "insensitive" as const } } } }
        ]
      } : {})
    };

    try {
      const [items, total] = await Promise.all([
        prisma.operationItem.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            siteId: true,
            status: true,
            errorMessage: true,
            createdAt: true,
            requestedUserId: true,
            beforeData: true,
            afterData: true,
            importRow: { select: { engineerName: true, address: true, rowNumber: true } },
            operation: {
              select: {
                id: true,
                type: true,
                status: true,
                createdAt: true,
                message: true,
                metadata: true,
                createdBy: { select: { displayName: true } }
              }
            }
          }
        }),
        prisma.operationItem.count({ where })
      ]);
      let engineerNames = new Map<string, string>();
      try {
        engineerNames = new Map((await getAssignmentUsers(yougile)).map((user) => [user.id, user.name]));
      } catch (error) {
        app.log.warn({ err: error }, "Could not resolve engineer names for history items");
      }

      return {
        page,
        pageSize,
        total,
        items: items.map((item) => {
          const metadataEngineer = stringProperty(item.operation.metadata, "targetUserName");
          const fileName = stringProperty(item.operation.metadata, "fileName");
          const taskTitle = stringProperty(item.beforeData, "title");
          const comment = stringProperty(item.operation.metadata, "comment");
          return {
            id: item.id,
            operationId: item.operation.id,
            type: item.operation.type,
            status: item.status,
            operationStatus: item.operation.status,
            siteId: item.siteId,
            engineer: item.importRow?.engineerName ??
              stringProperty(item.beforeData, "engineerName") ??
              metadataEngineer ??
              engineerNames.get(item.requestedUserId ?? "") ??
              item.requestedUserId ??
              "—",
            address: item.importRow?.address ?? taskTitle,
            rowNumber: item.importRow?.rowNumber ?? null,
            fileName,
            comment,
            user: displayName(item.operation.createdBy?.displayName),
            error: item.errorMessage,
            createdAt: item.operation.createdAt.toISOString()
          };
        })
      };
    } catch (error) {
      app.log.error({ err: error }, "Could not load operation history items");
      return reply.code(500).send({ error: "Не удалось загрузить список работ." });
    }
  });
}
