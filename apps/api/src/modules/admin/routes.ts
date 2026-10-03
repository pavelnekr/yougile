import type { FastifyInstance } from "fastify";
import { PortalRole, Prisma, type PrismaClient } from "@prisma/client";
import { hashPassword, requireRole } from "../auth/service.js";
import { adminUsersQuerySchema, createUserSchema, passwordResetSchema, updateUserSchema } from "./schema.js";
import { listUsersWithStats, resolveStatsPeriod } from "./service.js";

function publicAccount(user: { id: string; login: string; displayName: string; role: string; active: boolean }) {
  return {
    id: user.id,
    login: user.login,
    displayName: user.displayName,
    role: user.role,
    active: user.active
  };
}

/**
 * Управление учётными записями. Раздел доступен только роли ADMIN.
 * Глобальный хук server.ts уже проверил сессию, здесь проверяется роль.
 */
export async function registerAdminRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const adminOnly = requireRole(PortalRole.ADMIN);

  app.get("/api/admin/users", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = adminUsersQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Некорректный период статистики." });

    const result = await listUsersWithStats(prisma, resolveStatsPeriod(parsed.data.days));
    return { days: parsed.data.days, ...result };
  });

  app.post("/api/admin/users", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте данные учётной записи." });
    }

    const { login, displayName, password, role } = parsed.data;
    const existing = await prisma.portalUser.findUnique({ where: { login } });
    if (existing) {
      return reply.code(409).send({ error: "Пользователь с таким логином уже существует." });
    }

    try {
      const user = await prisma.portalUser.create({
        data: {
          login,
          passwordHash: await hashPassword(password),
          displayName: displayName ?? login,
          role: role ?? PortalRole.OPERATOR
        }
      });

      app.log.info(
        { actor: request.sessionUser?.login, login: user.login, role: user.role },
        "Portal account created by admin"
      );
      return reply.code(201).send({ user: publicAccount(user) });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.code(409).send({ error: "Пользователь с таким логином уже существует." });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/admin/users/:id", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = updateUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Нет изменений." });
    }

    const target = await prisma.portalUser.findUnique({ where: { id: request.params.id } });
    if (!target) return reply.code(404).send({ error: "Учётная запись не найдена." });

    const actorId = request.sessionUser?.id;
    const { displayName, role, active } = parsed.data;

    // Администратор не может закрыть себе доступ и не может снять с себя права.
    if (target.id === actorId) {
      if (active === false) {
        return reply.code(400).send({ error: "Нельзя заблокировать собственную учётную запись." });
      }
      if (role && role !== target.role) {
        return reply.code(400).send({ error: "Роль собственной учётной записи менять нельзя." });
      }
    }

    const losesAdminRights = target.role === PortalRole.ADMIN && target.active
      && ((role !== undefined && role !== PortalRole.ADMIN) || active === false);

    if (losesAdminRights) {
      const otherAdmins = await prisma.portalUser.count({
        where: { role: PortalRole.ADMIN, active: true, id: { not: target.id } }
      });
      if (otherAdmins === 0) {
        return reply.code(400).send({ error: "В портале должен остаться хотя бы один активный администратор." });
      }
    }

    const updated = await prisma.$transaction(async (transaction) => {
      const user = await transaction.portalUser.update({
        where: { id: target.id },
        data: { ...(displayName !== undefined ? { displayName } : {}), ...(role ? { role } : {}), ...(active !== undefined ? { active } : {}) }
      });
      // Блокировка сразу завершает сессии, иначе пользователь продолжит работать
      // до истечения cookie.
      const sessions = active === false
        ? await transaction.portalSession.deleteMany({ where: { userId: user.id } })
        : { count: 0 };
      return { user, revokedSessions: sessions.count };
    });

    app.log.warn(
      {
        actor: request.sessionUser?.login,
        target: updated.user.login,
        changes: { displayName, role, active },
        revokedSessions: updated.revokedSessions
      },
      "Portal account updated by admin"
    );

    return {
      user: publicAccount(updated.user),
      revokedSessions: updated.revokedSessions
    };
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/password", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = passwordResetSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Пароль должен быть не короче 8 символов." });
    }

    const target = await prisma.portalUser.findUnique({ where: { id: request.params.id } });
    if (!target) return reply.code(404).send({ error: "Учётная запись не найдена." });

    const isSelf = target.id === request.sessionUser?.id;
    const passwordHash = await hashPassword(parsed.data.password);

    const revokedSessions = await prisma.$transaction(async (transaction) => {
      await transaction.portalUser.update({ where: { id: target.id }, data: { passwordHash } });
      // Свою сессию не рвём, иначе администратор вылетит из формы в момент смены пароля.
      if (isSelf) return 0;
      const sessions = await transaction.portalSession.deleteMany({ where: { userId: target.id } });
      return sessions.count;
    });

    // Пароль в лог не пишем: только факт смены и кому.
    app.log.warn(
      { actor: request.sessionUser?.login, target: target.login, self: isSelf, revokedSessions },
      "Portal account password changed by admin"
    );

    return { ok: true, revokedSessions };
  });
}
