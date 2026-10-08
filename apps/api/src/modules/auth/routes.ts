import type { FastifyInstance } from "fastify";
import { PortalRole, Prisma, type PrismaClient } from "@prisma/client";
import { loginSchema, registerSchema } from "./schema.js";
import { clearRateLimit, rateLimitState, recordRateLimit, type RateLimit } from "./rate-limit.js";
import { annotateLog } from "../logs/service.js";
import {
  clearSessionCookie,
  createSession,
  decoyPasswordHash,
  destroySession,
  hashPassword,
  isRegistrationKeyEnabled,
  isRegistrationKeyValid,
  resolveSession,
  setSessionCookie,
  TooManyHashesError,
  verifyPassword
} from "./service.js";

// Пределы на неудачные попытки входа за 15 минут (окно общее, см. rate-limit.ts).
// По логину предел строгий: это и есть перебор пароля. По адресу — втрое выше,
// потому что за одним адресом могут сидеть несколько сотрудников офиса.
const loginPerLoginLimit: RateLimit = {
  limit: 10,
  message: "Слишком много попыток входа для этого логина. Попробуйте через 15 минут."
};
const loginPerIpLimit: RateLimit = {
  limit: 30,
  message: "Слишком много попыток входа с этого адреса. Попробуйте позже."
};

// Регистрация по ключу: перебор ключа дороже перебора логина, потому что удача
// даёт OPERATOR-доступ. Счётчики ведём по адресу и по логину — иначе через один
// прокси можно было бы вести параллельный перебор многих логинов, не упираясь
// в per-IP предел. Лимиты щедрее логинных: ключ вводят редко и обычно с первого раза.
const registerPerIpLimit: RateLimit = {
  limit: 20,
  message: "Слишком много попыток регистрации с этого адреса. Попробуйте позже."
};
const registerPerLoginLimit: RateLimit = {
  limit: 8,
  message: "Слишком много попыток регистрации для этого логина. Попробуйте через 15 минут."
};

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
  yougileTokenEncrypted?: string | null;
}) {
  return {
    id: user.id,
    login: user.login,
    displayName: user.displayName,
    role: user.role,
    yougileTokenConfigured: Boolean(user.yougileTokenEncrypted)
  };
}

export async function registerAuthRoutes(app: FastifyInstance, prisma: PrismaClient) {
  if (!isRegistrationKeyEnabled()) {
    app.log.warn("REGISTRATION_KEY is not set, self-registration in the portal is disabled");
  }

  app.get("/api/auth/session", async (request, reply) => {
    const session = await resolveSession(prisma, request);
    if (!session) return reply.code(401).send({ error: "Активной сессии нет." });
    const yougileCredential = await prisma.portalUser.findUnique({
      where: { id: session.user.id },
      select: { yougileTokenEncrypted: true }
    });
    return {
      user: publicUser({ ...session.user, yougileTokenEncrypted: yougileCredential?.yougileTokenEncrypted }),
      expiresAt: session.expiresAt.toISOString()
    };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Введите логин и пароль." });
    }

    // Счётчики ведём по логину и по адресу. Ключ логина в нижнем регистре, хотя
    // поиск в базе регистрозависимый: иначе перебор можно было бы вести
    // «Admin», «admin», «ADMIN» и утраивать себе лимит.
    const loginKey = `login:${parsed.data.login.toLowerCase()}`;
    const ipKey = `ip:${request.ip}`;

    // Проверяем до обращения к базе и до scrypt, чтобы отказ не стоил ничего.
    const limits: [string, RateLimit][] = [
      [loginKey, loginPerLoginLimit],
      [ipKey, loginPerIpLimit]
    ];
    for (const [key, limit] of limits) {
      const blocked = rateLimitState(key, limit);
      if (!blocked) continue;
      request.log.warn({ login: parsed.data.login, ip: request.ip }, "Rejected portal login by rate limit");
      return reply
        .code(429)
        .header("Retry-After", String(blocked.retryAfterSeconds))
        .send({ error: limit.message });
    }

    const user = await prisma.portalUser.findUnique({
      where: { login: parsed.data.login }
    });

    // Считаем пароль даже для несуществующего логина, чтобы по времени ответа
    // нельзя было перебирать существующие учётные записи. Подмена обязана быть
    // настоящим scrypt-хешем, инача verifyPassword возвращает false раньше
    // вычисления и время ответа выдаёт существующие логины (см. decoyPasswordHash).
    let passwordMatches: boolean;
    try {
      passwordMatches = await verifyPassword(
        parsed.data.password,
        user?.passwordHash ?? (await decoyPasswordHash())
      );
    } catch (error) {
      if (error instanceof TooManyHashesError) {
        request.log.warn({ err: error, ip: request.ip }, "Portal login rejected: scrypt limit reached");
        return reply.code(503).send({ error: "Сервер перегружен. Попробуйте через минуту." });
      }
      throw error;
    }

    // Неудача считается по обоим ключам: успешный вход ничего не учитывает.
    const rejectCredentials = () => {
      recordRateLimit(loginKey);
      recordRateLimit(ipKey);
      return reply.code(401).send({ error: "Неверный логин или пароль." });
    };

    if (!user) {
      request.log.info({ login: parsed.data.login }, "Rejected portal login attempt");
      return rejectCredentials();
    }
    if (!passwordMatches) {
      request.log.info({ login: user.login }, "Rejected portal login attempt");
      return rejectCredentials();
    }
    if (!user.active) {
      // Отключение — это решение администратора, а не подбор пароля, поэтому
      // счётчик попыток здесь не растёт: иначе сотрудник с отключённой учётной
      // записью получал бы «слишком много попыток» вместо внятного объяснения.
      request.log.info({ login: user.login }, "Rejected login for disabled account");
      return reply.code(403).send({ error: "Учётная запись отключена." });
    }

    // Вход состоялся — попытки по этому логину снова разрешены.
    clearRateLimit(loginKey);

    const rememberMe = parsed.data.rememberMe ?? false;
    const { token, expiresAt } = await createSession(
      prisma,
      user.id,
      rememberMe ? "long" : "short",
      typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null
    );
    setSessionCookie(reply, token, expiresAt, isSecureRequest(request));

    request.log.info({ login: user.login, rememberMe }, "Portal session started");
    // Без этой строки журнал показал бы лишь «POST /api/auth/login → 200»:
    // сессия в ответе есть, а вот каким логином вошли — нет.
    annotateLog(request, { message: "Вход в портал выполнен", entityId: user.id });
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

    // Проверяем до обращения к базе и до scrypt, чтобы отказ не стоил ничего.
    // Ключ логина в нижнем регистре по той же причине, что и на входе.
    const registerLoginKey = `register:${parsed.data.login.toLowerCase()}`;
    const registerIpKey = `register-ip:${request.ip}`;
    const registerLimits: [string, RateLimit][] = [
      [registerLoginKey, registerPerLoginLimit],
      [registerIpKey, registerPerIpLimit]
    ];
    for (const [key, limit] of registerLimits) {
      const blocked = rateLimitState(key, limit);
      if (!blocked) continue;
      request.log.warn({ login: parsed.data.login, ip: request.ip }, "Rejected portal registration by rate limit");
      return reply
        .code(429)
        .header("Retry-After", String(blocked.retryAfterSeconds))
        .send({ error: limit.message });
    }

    if (!isRegistrationKeyValid(parsed.data.registrationKey)) {
      // Ключ в лог не пишем: достаточно логина и адреса клиента.
      request.log.warn({ login: parsed.data.login, ip: request.ip }, "Rejected portal registration attempt");
      // Неудача считается по обоим ключам: успешная регистрация ничего не учитывает.
      recordRateLimit(registerLoginKey);
      recordRateLimit(registerIpKey);
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

    // Регистрация состоялась — попытки по этому логину снова разрешены.
    clearRateLimit(registerLoginKey);

    request.log.info({ login: user.login, role: user.role }, "Portal account registered");
    annotateLog(request, { message: "Регистрация завершена", entityId: user.id });
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
    // Путь /api/auth/ исключён из глобальной проверки сессии, поэтому здесь
    // request.sessionUser пуст. Без явного чтения в журнале осталась бы запись
    // о выходе без имени того, кто вышел, а это одно из действий сотрудника.
    const session = await resolveSession(prisma, request);
    if (session) request.sessionUser = session.user;
    await destroySession(prisma, request);
    clearSessionCookie(reply, isSecureRequest(request));
    annotateLog(request, { message: "Выход из портала" });
    return { ok: true };
  });
});
}
