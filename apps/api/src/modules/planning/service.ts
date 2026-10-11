import type { PrismaClient, Prisma } from "@prisma/client";
import { planRowFieldsSchema, planFiltersSchema, type PlanFilters, type PlanRow, type PlanListResponse } from "./schema.js";

const MAX_ROWS = 3000;

/** Нормализует ввод: пустая строка → null, trim. */
function normalizeString(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  return t.length ? t : null;
}

/** Строит Prisma where из фильтров. */
function buildWhere(f: PlanFilters): Prisma.PlanRowWhereInput {
  const and: Prisma.PlanRowWhereInput[] = [];

  // Полнотекстовый поиск
  if (f.q) {
    const textFields: Array<keyof Prisma.PlanRowWhereInput> = [
      "shift", "timeWindow", "siteId", "address", "po", "comment",
      "engineer", "comment2", "status", "cluster", "free1", "free2", "free3"
    ];
    and.push({
      OR: textFields.map((field) => ({
        [field]: { contains: f.q!, mode: "insensitive" }
      }))
    });
  }

  // Диапазон дат
  if (f.dateFrom) {
    and.push({ planDate: { gte: new Date(`${f.dateFrom}T00:00:00.000Z`) } });
  }
  if (f.dateTo) {
    and.push({ planDate: { lte: new Date(`${f.dateTo}T23:59:59.999Z`) } });
  }

  // CSV-фильтры с поддержкой __empty__
  const csvField = (field: string, csv?: string) => {
    if (!csv) return null;
    const values = csv.split(",").map((v) => v.trim()).filter((v) => v.length);
    if (!values.length) return null;
    const hasEmpty = values.includes("__empty__");
    const real = values.filter((v) => v !== "__empty__");
    const ors: Prisma.PlanRowWhereInput[] = [];
    if (real.length) ors.push({ [field]: { in: real } });
    if (hasEmpty) ors.push({ [field]: null }, { [field]: "" });
    return ors.length === 1 ? ors[0] : { OR: ors };
  };

  const addCsv = (field: string, csv?: string) => {
    const cond = csvField(field, csv);
    if (cond) and.push(cond);
  };

  addCsv("shift", f.shift);
  addCsv("engineer", f.engineer);
  addCsv("status", f.status);
  addCsv("cluster", f.cluster);
  addCsv("po", f.po);

  // Текстовые поля
  if (f.time) and.push({ timeWindow: { contains: f.time, mode: "insensitive" } });
  if (f.siteId) and.push({ siteId: { contains: f.siteId, mode: "insensitive" } });
  if (f.address) and.push({ address: { contains: f.address, mode: "insensitive" } });
  if (f.free1) and.push({ free1: { contains: f.free1, mode: "insensitive" } });
  if (f.free2) and.push({ free2: { contains: f.free2, mode: "insensitive" } });
  if (f.free3) and.push({ free3: { contains: f.free3, mode: "insensitive" } });

  // Незаполненные ключевые поля (любое из выбранных пусто)
  if (f.incomplete) {
    const fields = f.incomplete.split(",").map((v) => v.trim()).filter((v) => v.length);
    if (fields.length) {
      and.push({
        OR: fields.flatMap((field) => [{ [field]: null }, { [field]: "" }])
      });
    }
  }

  return and.length ? { AND: and } : {};
}

/** Порядок сортировки. */
function buildOrderBy(f: PlanFilters): Prisma.PlanRowOrderByWithRelationInput[] {
  const dir = f.dir === "desc" ? "desc" : "asc";
  const allowed = new Set(["planDate", "shift", "timeWindow", "siteId", "address", "po", "engineer", "status", "cluster", "sortOrder", "createdAt", "updatedAt"]);
  const primary = f.sort && allowed.has(f.sort) ? f.sort : "planDate";

  return [
    { [primary]: { sort: dir, nulls: "last" } },
    { sortOrder: "asc" },
    { createdAt: "asc" }
  ];
}

/** Получить уникальные значения для фильтров (чипы). */
export async function planFilterOptions(prisma: PrismaClient) {
  const [shift, engineer, status, cluster, po] = await Promise.all([
    prisma.planRow.findMany({ distinct: ["shift"], select: { shift: true }, where: { shift: { not: null } } }),
    prisma.planRow.findMany({ distinct: ["engineer"], select: { engineer: true }, where: { engineer: { not: null } } }),
    prisma.planRow.findMany({ distinct: ["status"], select: { status: true }, where: { status: { not: null } } }),
    prisma.planRow.findMany({ distinct: ["cluster"], select: { cluster: true }, where: { cluster: { not: null } } }),
    prisma.planRow.findMany({ distinct: ["po"], select: { po: true }, where: { po: { not: null } } })
  ]);

  const uniqSort = (arr: { [k: string]: string | null }[], key: string) =>
    Array.from(new Set(arr.map((r) => r[key]).filter((v): v is string => typeof v === "string" && v.length > 0)))
      .sort((a, b) => a.localeCompare(b, "ru"));

  return {
    shift: uniqSort(shift, "shift"),
    engineer: uniqSort(engineer, "engineer"),
    status: uniqSort(status, "status"),
    cluster: uniqSort(cluster, "cluster"),
    po: uniqSort(po, "po")
  };
}

/** Список строк с фильтрацией и опциями. */
export async function listPlanRows(prisma: PrismaClient, rawFilters: Record<string, unknown>): Promise<PlanListResponse> {
  const parse = planFiltersSchema.safeParse(rawFilters);
  if (!parse.success) {
    // На невалидные фильтры возвращаем пустой список, не падаем
    return { items: [], total: 0, filtered: 0, options: { shift: [], engineer: [], status: [], cluster: [], po: [] } };
  }
  const filters = parse.data;

  const where = buildWhere(filters);
  const orderBy = buildOrderBy(filters);

  const [total, filtered, items, options] = await Promise.all([
    prisma.planRow.count(),
    prisma.planRow.count({ where }),
    prisma.planRow.findMany({ where, orderBy, take: MAX_ROWS }),
    planFilterOptions(prisma)
  ]);

  const mapped: PlanRow[] = items.map((r) => ({
    id: r.id,
    planDate: r.planDate ? r.planDate.toISOString().slice(0, 10) : null,
    shift: r.shift,
    timeWindow: r.timeWindow,
    siteId: r.siteId,
    address: r.address,
    po: r.po,
    comment: r.comment,
    engineer: r.engineer,
    comment2: r.comment2,
    status: r.status,
    cluster: r.cluster,
    free1: r.free1,
    free2: r.free2,
    free3: r.free3,
    sortOrder: r.sortOrder,
    createdById: r.createdById,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString()
  }));

  return { items: mapped, total, filtered, options };
}

/** Создать строку. */
export async function createPlanRow(
  prisma: PrismaClient,
  data: Record<string, unknown>,
  userId: string | null
): Promise<PlanRow> {
  const parsed = planRowFieldsSchema.parse(data);
  // sortOrder = max + 1
  const maxSort = await prisma.planRow.aggregate({ _max: { sortOrder: true } });
  const sortOrder = (maxSort._max.sortOrder ?? -1) + 1;

  const row = await prisma.planRow.create({
    data: {
      planDate: parsed.planDate ? new Date(`${parsed.planDate}T00:00:00.000Z`) : null,
      shift: normalizeString(parsed.shift),
      timeWindow: normalizeString(parsed.timeWindow),
      siteId: normalizeString(parsed.siteId),
      address: normalizeString(parsed.address),
      po: normalizeString(parsed.po),
      comment: normalizeString(parsed.comment),
      engineer: normalizeString(parsed.engineer),
      comment2: normalizeString(parsed.comment2),
      status: normalizeString(parsed.status),
      cluster: normalizeString(parsed.cluster),
      free1: normalizeString(parsed.free1),
      free2: normalizeString(parsed.free2),
      free3: normalizeString(parsed.free3),
      sortOrder,
      createdById: userId
    }
  });

  return {
    id: row.id,
    planDate: row.planDate ? row.planDate.toISOString().slice(0, 10) : null,
    shift: row.shift,
    timeWindow: row.timeWindow,
    siteId: row.siteId,
    address: row.address,
    po: row.po,
    comment: row.comment,
    engineer: row.engineer,
    comment2: row.comment2,
    status: row.status,
    cluster: row.cluster,
    free1: row.free1,
    free2: row.free2,
    free3: row.free3,
    sortOrder: row.sortOrder,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

/** Обновить строку (частично). */
export async function updatePlanRow(
  prisma: PrismaClient,
  id: string,
  data: Record<string, unknown>
): Promise<PlanRow | null> {
  const parsed = planRowFieldsSchema.partial().parse(data);
  const updateData: Prisma.PlanRowUpdateInput = {};

  if (parsed.planDate !== undefined) updateData.planDate = parsed.planDate ? new Date(`${parsed.planDate}T00:00:00.000Z`) : null;
  if (parsed.shift !== undefined) updateData.shift = normalizeString(parsed.shift);
  if (parsed.timeWindow !== undefined) updateData.timeWindow = normalizeString(parsed.timeWindow);
  if (parsed.siteId !== undefined) updateData.siteId = normalizeString(parsed.siteId);
  if (parsed.address !== undefined) updateData.address = normalizeString(parsed.address);
  if (parsed.po !== undefined) updateData.po = normalizeString(parsed.po);
  if (parsed.comment !== undefined) updateData.comment = normalizeString(parsed.comment);
  if (parsed.engineer !== undefined) updateData.engineer = normalizeString(parsed.engineer);
  if (parsed.comment2 !== undefined) updateData.comment2 = normalizeString(parsed.comment2);
  if (parsed.status !== undefined) updateData.status = normalizeString(parsed.status);
  if (parsed.cluster !== undefined) updateData.cluster = normalizeString(parsed.cluster);
  if (parsed.free1 !== undefined) updateData.free1 = normalizeString(parsed.free1);
  if (parsed.free2 !== undefined) updateData.free2 = normalizeString(parsed.free2);
  if (parsed.free3 !== undefined) updateData.free3 = normalizeString(parsed.free3);

  const row = await prisma.planRow.update({ where: { id }, data: updateData }).catch(() => null);
  if (!row) return null;

  return {
    id: row.id,
    planDate: row.planDate ? row.planDate.toISOString().slice(0, 10) : null,
    shift: row.shift,
    timeWindow: row.timeWindow,
    siteId: row.siteId,
    address: row.address,
    po: row.po,
    comment: row.comment,
    engineer: row.engineer,
    comment2: row.comment2,
    status: row.status,
    cluster: row.cluster,
    free1: row.free1,
    free2: row.free2,
    free3: row.free3,
    sortOrder: row.sortOrder,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

/** Удалить строку. */
export async function deletePlanRow(prisma: PrismaClient, id: string): Promise<boolean> {
  const res = await prisma.planRow.delete({ where: { id } }).catch(() => null);
  return !!res;
}