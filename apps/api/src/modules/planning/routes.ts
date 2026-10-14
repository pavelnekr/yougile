import type { FastifyInstance } from "fastify";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireWorkspaceAccess } from "../auth/service.js";

const optionalText = (max: number) => z.string().trim().max(max).optional();
const workSchema = z.object({
  free1: optionalText(2_000),
  data: z.string().trim().max(10).optional(),
  day: optionalText(40),
  time: optionalText(20),
  id_site: z.string().trim().min(1, "Укажите номер площадки.").max(100),
  address: optionalText(2_000),
  PO: optionalText(255),
  comment: optionalText(10_000),
  free2: optionalText(2_000),
  free3: optionalText(2_000),
  user: optionalText(255),
  comment2: optionalText(10_000),
  status: optionalText(100),
  klaster: optionalText(255)
}).superRefine((value, context) => {
  if (value.data && (!/^\d{4}-\d{2}-\d{2}$/.test(value.data) || Number.isNaN(Date.parse(`${value.data}T00:00:00Z`)))) {
    context.addIssue({ code: "custom", path: ["data"], message: "Укажите корректную дату." });
  }
});

const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  siteId: z.string().trim().max(100).optional(),
  status: z.string().trim().max(100).optional(),
  day: z.string().trim().max(40).optional(),
  klaster: z.string().trim().max(255).optional(),
  user: z.string().trim().max(255).optional(),
  from: z.string().trim().max(10).optional(),
  to: z.string().trim().max(10).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50)
});

function nullable<T>(value: T | undefined): T | null {
  if (typeof value === "string" && value.trim() === "") return null;
  return (value ?? null) as T | null;
}

function toDbData(input: z.infer<typeof workSchema>) {
  return {
    free1: nullable(input.free1),
    workDate: input.data ? new Date(`${input.data}T00:00:00.000Z`) : null,
    day: nullable(input.day),
    time: nullable(input.time),
    siteId: input.id_site,
    address: nullable(input.address),
    po: nullable(input.PO),
    comment: nullable(input.comment),
    free2: nullable(input.free2),
    free3: nullable(input.free3),
    assignee: nullable(input.user),
    comment2: nullable(input.comment2),
    status: nullable(input.status),
    cluster: nullable(input.klaster)
  };
}

function toApiWork(work: {
  id: string; free1: string | null; workDate: Date | null; day: string | null; time: string | null;
  siteId: string; address: string | null; po: string | null; comment: string | null; free2: string | null;
  free3: string | null; assignee: string | null; comment2: string | null; status: string | null;
  cluster: string | null; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: work.id,
    free1: work.free1,
    data: work.workDate?.toISOString().slice(0, 10) ?? "",
    day: work.day,
    time: work.time,
    id_site: work.siteId,
    address: work.address,
    PO: work.po,
    comment: work.comment,
    free2: work.free2,
    free3: work.free3,
    user: work.assignee,
    comment2: work.comment2,
    status: work.status,
    klaster: work.cluster,
    createdAt: work.createdAt.toISOString(),
    updatedAt: work.updatedAt.toISOString()
  };
}

export async function registerPlanningRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const readAccess = requireWorkspaceAccess("WORK_PLANNING");
  const writeAccess = requireWorkspaceAccess("WORK_PLANNING", true);

  app.get<{ Querystring: Record<string, string | undefined> }>("/api/planning/works", { preHandler: readAccess }, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Проверьте параметры фильтрации." });
    const { q, siteId, status, day, klaster, user, from, to, page, pageSize } = parsed.data;
    if ((from && (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(`${from}T00:00:00Z`)))) ||
      (to && (!/^\d{4}-\d{2}-\d{2}$/.test(to) || Number.isNaN(Date.parse(`${to}T00:00:00Z`))))) {
      return reply.code(400).send({ error: "Укажите корректный период дат." });
    }
    if (from && to && from > to) return reply.code(400).send({ error: "Дата начала периода не может быть позже даты окончания." });

    const where: Prisma.PlanningWorkWhereInput = {
      ...(siteId ? { siteId: { contains: siteId, mode: "insensitive" } } : {}),
      ...(status ? { status } : {}),
      ...(day ? { day } : {}),
      ...(klaster ? { cluster: klaster } : {}),
      ...(user ? { assignee: user } : {}),
      ...(from || to ? { workDate: { ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}), ...(to ? { lte: new Date(`${to}T00:00:00.000Z`) } : {}) } } : {}),
      ...(q ? { OR: [
        { siteId: { contains: q, mode: "insensitive" } },
        { address: { contains: q, mode: "insensitive" } },
        { po: { contains: q, mode: "insensitive" } },
        { comment: { contains: q, mode: "insensitive" } },
        { free1: { contains: q, mode: "insensitive" } },
        { free2: { contains: q, mode: "insensitive" } },
        { free3: { contains: q, mode: "insensitive" } },
        { assignee: { contains: q, mode: "insensitive" } },
        { comment2: { contains: q, mode: "insensitive" } },
        { status: { contains: q, mode: "insensitive" } },
        { cluster: { contains: q, mode: "insensitive" } },
        { day: { contains: q, mode: "insensitive" } },
        { time: { contains: q, mode: "insensitive" } }
      ] } : {})
    };

    try {
      const [works, total, statuses, days, clusters, users] = await Promise.all([
        prisma.planningWork.findMany({ where, orderBy: [{ workDate: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
        prisma.planningWork.count({ where }),
        prisma.planningWork.findMany({ where: { status: { not: null } }, distinct: ["status"], select: { status: true }, orderBy: { status: "asc" } })
        ,prisma.planningWork.findMany({ where: { day: { not: null } }, distinct: ["day"], select: { day: true }, orderBy: { day: "asc" } })
        ,prisma.planningWork.findMany({ where: { cluster: { not: null } }, distinct: ["cluster"], select: { cluster: true }, orderBy: { cluster: "asc" } })
        ,prisma.planningWork.findMany({ where: { assignee: { not: null } }, distinct: ["assignee"], select: { assignee: true }, orderBy: { assignee: "asc" } })
      ]);
      return {
        items: works.map(toApiWork), total, page, pageSize,
        statuses: statuses.map((item) => item.status).filter((value): value is string => Boolean(value)),
        days: days.map((item) => item.day).filter((value): value is string => Boolean(value)),
        clusters: clusters.map((item) => item.cluster).filter((value): value is string => Boolean(value)),
        users: users.map((item) => item.assignee).filter((value): value is string => Boolean(value))
      };
    } catch (error) {
      app.log.error({ err: error }, "Could not list planning works");
      return reply.code(500).send({ error: "Не удалось загрузить список работ." });
    }
  });

  app.post("/api/planning/works", { preHandler: writeAccess }, async (request, reply) => {
    const parsed = workSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте поля работы." });
    try {
      const work = await prisma.planningWork.create({ data: { ...toDbData(parsed.data), createdById: request.sessionUser?.id ?? null } });
      return reply.code(201).send({ item: toApiWork(work) });
    } catch (error) {
      app.log.error({ err: error, actor: request.sessionUser?.login }, "Could not create planning work");
      return reply.code(500).send({ error: "Не удалось сохранить работу." });
    }
  });

  app.patch<{ Params: { id: string } }>("/api/planning/works/:id", { preHandler: writeAccess }, async (request, reply) => {
    const parsed = workSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте поля работы." });
    try {
      const result = await prisma.planningWork.updateMany({ where: { id: request.params.id }, data: toDbData(parsed.data) });
      if (!result.count) return reply.code(404).send({ error: "Работа не найдена." });
      const work = await prisma.planningWork.findUniqueOrThrow({ where: { id: request.params.id } });
      return { item: toApiWork(work) };
    } catch (error) {
      app.log.error({ err: error, actor: request.sessionUser?.login, workId: request.params.id }, "Could not update planning work");
      return reply.code(500).send({ error: "Не удалось обновить работу." });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/planning/works/:id", { preHandler: writeAccess }, async (request, reply) => {
    try {
      const result = await prisma.planningWork.deleteMany({ where: { id: request.params.id } });
      if (!result.count) return reply.code(404).send({ error: "Работа не найдена." });
      return reply.code(204).send();
    } catch (error) {
      app.log.error({ err: error, actor: request.sessionUser?.login, workId: request.params.id }, "Could not delete planning work");
      return reply.code(500).send({ error: "Не удалось удалить работу." });
    }
  });
}
