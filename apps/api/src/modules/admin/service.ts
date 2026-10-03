import type { OperationStatus, PrismaClient } from "@prisma/client";

/**
 * Статистика одного сотрудника за выбранный период.
 * Считается из Operation.createdById: автор операции пишется при постановке
 * в очередь, поэтому сюда попадает всё, что сотрудник реально запустил.
 */
export type AdminUserStats = {
  operations: number;
  succeeded: number;
  partial: number;
  failed: number;
  inProgress: number;
  sitesTotal: number;
  sitesSucceeded: number;
  sitesFailed: number;
  imports: number;
  byType: { ASSIGN: number; REMOVE: number; COMMENT: number };
  lastOperationAt: string | null;
};

export type AdminUserRow = {
  id: string;
  login: string;
  displayName: string;
  role: string;
  active: boolean;
  createdAt: string;
  activeSessions: number;
  lastSeenAt: string | null;
  stats: AdminUserStats;
};

function emptyStats(): AdminUserStats {
  return {
    operations: 0,
    succeeded: 0,
    partial: 0,
    failed: 0,
    inProgress: 0,
    sitesTotal: 0,
    sitesSucceeded: 0,
    sitesFailed: 0,
    imports: 0,
    byType: { ASSIGN: 0, REMOVE: 0, COMMENT: 0 },
    lastOperationAt: null
  };
}

/**
 * Статусы, которые в статистике считаются ошибкой. CANCELLED в портале не
 * выставляется, но если появится в будущем, его логично видеть рядом с FAILED.
 */
const failedStatuses: OperationStatus[] = ["FAILED", "CANCELLED"];
const inProgressStatuses: OperationStatus[] = ["QUEUED", "RUNNING"];

export type StatsPeriod = { since: Date | null };

export function resolveStatsPeriod(days: string): StatsPeriod {
  if (days === "all") return { since: null };
  const parsed = Number(days);
  if (!Number.isFinite(parsed) || parsed <= 0) return { since: null };
  return { since: new Date(Date.now() - parsed * 24 * 60 * 60 * 1000) };
}

/**
 * Все учётные записи вместе со статистикой работы за период.
 *
 * Агрегаты собираются тремя groupBy-запросами, а не по одному запросу на
 * сотрудника: список короткий, но запросов иначе получилось бы N+1.
 */
export async function listUsersWithStats(prisma: PrismaClient, period: StatsPeriod) {
  const now = new Date();
  const users = await prisma.portalUser.findMany({
    orderBy: [{ role: "asc" }, { login: "asc" }],
    include: {
      // Протухшие сессии в активности не показываем.
      sessions: { where: { expiresAt: { gt: now } }, select: { lastSeenAt: true } }
    }
  });

  const operationWhere = {
    createdById: { not: null },
    ...(period.since ? { createdAt: { gte: period.since } } : {})
  };
  const importWhere = period.since ? { createdAt: { gte: period.since } } : {};

  const [byStatus, byType, imports] = await Promise.all([
    prisma.operation.groupBy({
      by: ["createdById", "status"],
      where: operationWhere,
      _count: { _all: true },
      _sum: { total: true, completed: true, failed: true },
      _max: { createdAt: true }
    }),
    prisma.operation.groupBy({
      by: ["createdById", "type"],
      where: operationWhere,
      _count: { _all: true }
    }),
    prisma.importBatch.groupBy({
      by: ["createdById"],
      where: importWhere,
      _count: { _all: true }
    })
  ]);

  const statsByUser = new Map<string, AdminUserStats>();
  const statsFor = (userId: string) => {
    const existing = statsByUser.get(userId);
    if (existing) return existing;
    const created = emptyStats();
    statsByUser.set(userId, created);
    return created;
  };

  for (const row of byStatus) {
    if (!row.createdById) continue;
    const stats = statsFor(row.createdById);
    const count = row._count._all;
    stats.operations += count;
    stats.sitesTotal += row._sum.total ?? 0;
    stats.sitesSucceeded += row._sum.completed ?? 0;
    stats.sitesFailed += row._sum.failed ?? 0;

    if (row.status === "SUCCEEDED") stats.succeeded += count;
    else if (row.status === "PARTIAL") stats.partial += count;
    else if (failedStatuses.includes(row.status)) stats.failed += count;
    else if (inProgressStatuses.includes(row.status)) stats.inProgress += count;

    if (row._max.createdAt && (!stats.lastOperationAt || row._max.createdAt > new Date(stats.lastOperationAt))) {
      stats.lastOperationAt = row._max.createdAt.toISOString();
    }
  }

  for (const row of byType) {
    if (!row.createdById) continue;
    const stats = statsFor(row.createdById);
    const count = row._count._all;
    if (row.type === "ASSIGN") stats.byType.ASSIGN += count;
    else if (row.type === "REMOVE") stats.byType.REMOVE += count;
    else if (row.type === "COMMENT") stats.byType.COMMENT += count;
  }

  for (const row of imports) {
    if (!row.createdById) continue;
    statsFor(row.createdById).imports += row._count._all;
  }

  const items: AdminUserRow[] = users.map((user) => {
    const lastSeenAt = user.sessions.reduce<Date | null>((latest, session) => {
      if (!latest || session.lastSeenAt > latest) return session.lastSeenAt;
      return latest;
    }, null);

    return {
      id: user.id,
      login: user.login,
      displayName: user.displayName,
      role: user.role,
      active: user.active,
      createdAt: user.createdAt.toISOString(),
      activeSessions: user.sessions.length,
      lastSeenAt: lastSeenAt?.toISOString() ?? null,
      stats: statsByUser.get(user.id) ?? emptyStats()
    };
  });

  const totals = items.reduce(
    (accumulator, item) => {
      accumulator.users += 1;
      if (item.active) accumulator.active += 1;
      else accumulator.blocked += 1;
      if (item.role === "ADMIN") accumulator.admins += 1;
      accumulator.operations += item.stats.operations;
      accumulator.failedOperations += item.stats.failed;
      accumulator.sitesSucceeded += item.stats.sitesSucceeded;
      accumulator.sitesFailed += item.stats.sitesFailed;
      accumulator.imports += item.stats.imports;
      return accumulator;
    },
    {
      users: 0,
      active: 0,
      blocked: 0,
      admins: 0,
      operations: 0,
      failedOperations: 0,
      sitesSucceeded: 0,
      sitesFailed: 0,
      imports: 0
    }
  );

  return { items, totals };
}
