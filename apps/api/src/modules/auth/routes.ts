import type { FastifyInstance } from "fastify";
import { PortalRole, Prisma, type PrismaClient } from "@prisma/client";
import { loginSchema, registerSchema } from "./schema.js";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  hashPassword,
  isRegistrationKeyEnabled,
  isRegistrationKeyValid,
  resolveSession,
  setSessionCookie,
  verifyPassword
} from "./service.js";

// Cookie ставим с флагом secure только когда сам запрос пришёл по HTTPS.
// Иначе локальная разработка по http://localhost не сможет сохранить сессию.
function isSecureRequest(request: { protocol: string; headers: Record<string, unknown> }) {
  if (request.protocol === "https") return true;
  return request.headers["x-forwarded-proto"] === "https";
}

function publicUser(user: {
  id: string;
  login: string;
  displayName: string;
  role: string;
}) {
  return {
    id: user.id,
    login: user.login,
    displayName: user.displayName,
    role: user.role
  };
}

export async function registerAuthRoutes(app: FastifyInstance, prisma: PrismaClient) {
  if (!isRegistrationKeyEnabled()) {
    app.log.warn("REGISTRATION_KEY is not set, self-registration in the portal is disabled");
  }

  app.get("/api/auth/session", async (request, reply) => {
    const session = await resolveSession(prisma, request);
    if (!session) return reply.code(401).send({ error: "Активной сессии нет." });
    return { user: publicUser(session.user), expiresAt: session.expiresAt.toISOString() };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Введите логин и пароль." });
    }

    const user = await prisma.portalUser.findUnique({
      where: { login: parsed.data.login }
    });

    // Считаем пароль даже для несуществующего логина, чтобы по времени ответа
    // нельзя было перебирать существующие учётные записи.
    const passwordMatches = await verifyPassword(
      parsed.data.password,
      user?.passwordHash ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA"
    );

    if (!user) {
      request.log.info({ login: parsed.data.login }, "Rejected portal login attempt");
      return reply.code(401).send({ error: "Неверный логин или пароль." });
    }
    if (!passwordMatches) {
      request.log.info({ login: user.login }, "Rejected portal login attempt");
      return reply.code(401).send({ error: "Неверный логин или пароль." });
    }
    if (!user.active) {
      request.log.info({ login: user.login }, "Rejected login for disabled account");
      return reply.code(403).send({ error: "Учётная запись отключена." });
    }

    const rememberMe = parsed.data.rememberMe ?? false;
    const { token, expiresAt } = await createSession(
      prisma,
      user.id,
      rememberMe ? "long" : "short",
      typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null
    );
    setSessionCookie(reply, token, expiresAt, isSecureRequest(request));

    request.log.info({ login: user.login, rememberMe }, "Portal session started");
    return { user: publicUser(user), expiresAt: expiresAt.toISOString(), rememberMe };
  });

  // Самостоятельная регистрация по ключу администратора. Сессия выдаётся сразу,
  // поэтому после регистрации отдельный вход не требуется.
  app.post("/api/auth/register", async (request, reply) => {
    if (!isRegistrationKeyEnabled()) {
      return reply.code(503).send({ error: "Регистрация в портале выключена." });
    }

    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Проверьте данные регистрации.";
      return reply.code(400).send({ error: message });
    }

    if (!isRegistrationKeyValid(parsed.data.registrationKey)) {
      // Ключ в лог не пишем: достаточно логина и адреса клиента.
      request.log.warn({ login: parsed.data.login, ip: request.ip }, "Rejected portal registration attempt");
      return reply.code(403).send({ error: "Ключ регистрации не подходит." });
    }

    const login = parsed.data.login;
    let user;
    try {
      user = await prisma.portalUser.create({
        data: {
          login,
          passwordHash: await hashPassword(parsed.data.password),
          displayName: parsed.data.displayName ?? login,
          role: PortalRole.OPERATOR
        }
      });
    } catch (error) {
      // Гонка двух одинаковых логинов: уникальный индекс срабатывает быстрее, чем
      // успела бы отработать предварительная проверка, поэтому ответ тот же.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        request.log.info({ login }, "Rejected portal registration for existing login");
        return reply.code(409).send({ error: "Пользователь с таким логином уже существует." });
      }
      throw error;
    }

    const userAgent = typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null;
    const { token, expiresAt } = await createSession(prisma, user.id, "long", userAgent);
    setSessionCookie(reply, token, expiresAt, isSecureRequest(request));

    request.log.info({ login: user.login, role: user.role }, "Portal account registered");
    return reply.code(201).send({ user: publicUser(user), expiresAt: expiresAt.toISOString() });
  });

  // Маршруты входа и выхода намеренно изолированы: Fastify отвечает 415 на POST
// без поддерживаемого Content-Type, а выход клиенты шлют по-разному (fetch без
// тела, curl, формы). Здесь принимается любой Content-Type — multipart-парсер
// импортов при этом не затрагивается, он зарегистрирован в другом контексте.
await app.register(async (authRoutes) => {
  authRoutes.addContentTypeParser(/.*/, (_request, _payload, done) => {
    done(null, undefined);
  });

  authRoutes.post("/api/auth/logout", async (request, reply) => {
    await destroySession(prisma, request);
    clearSessionCookie(reply, isSecureRequest(request));
    return { ok: true };
  });
});
}
