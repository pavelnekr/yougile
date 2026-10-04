// Хеширование паролей и управление сессиями на встроенном node:crypto.
// Зависимости не добавляются намеренно: node_modules в контейнере перекрыт volume,
// поэтому новая библиотека потребовала бы пересборки образа.
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PortalRole, PrismaClient } from "@prisma/client";
import { config } from "../../config.js";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const keyLength = 64;
const saltBytes = 16;

// scrypt дорогой: ~16 МБ памяти на попытку. Предел на число одновременных
// вычислений нужен, чтобы пачка параллельных запросов входа не расходовала память
// процесса. При исчерпании предела вызов отклоняется, а не ставится в очередь:
// иначе очередь только откладывает отказ, удерживая тела запросов в памяти.
//
// По умолчанию libuv держит 4 рабочих потока, поэтому фактический потолок ниже
// этого предела и память процесса упирается примерно в 64 МБ. Замер: при
// UV_THREADPOOL_SIZE=32 пятьдесят параллельных вызовов давали прирост RSS
// до 472 МБ. Поэтому UV_THREADPOOL_SIZE в контейнере API не задаётся, а этот
// предел остаётся на случай, если его всё же поднимут.
const maxConcurrentHashes = 8;
let runningHashes = 0;

export class TooManyHashesError extends Error {
  constructor() {
    super("Превышен предел одновременных проверок пароля");
    this.name = "TooManyHashesError";
  }
}

/**
 * Единственная точка, где считается scrypt. Слот берётся до запуска и
 * отпускается на settled, поэтому окно считается по фактическим вычислениям,
 * а не по времени ожидания в очереди libuv.
 */
async function deriveKey(password: string, salt: Buffer) {
  if (runningHashes >= maxConcurrentHashes) throw new TooManyHashesError();
  runningHashes += 1;
  try {
    return await scryptAsync(password.normalize("NFKC"), salt, keyLength);
  } finally {
    runningHashes -= 1;
  }
}

export const sessionCookieName = "portal_session";

export type SessionDuration = "short" | "long";
export const sessionDurations: Record<SessionDuration, number> = {
  short: 12 * 60 * 60 * 1000,
  long: 30 * 24 * 60 * 60 * 1000
};

export async function hashPassword(password: string) {
  const salt = randomBytes(saltBytes);
  const derived = await deriveKey(password, salt);
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, storedHash: string) {
  const [algorithm, saltPart, hashPart] = storedHash.split("$");
  if (algorithm !== "scrypt" || !saltPart || !hashPart) return false;

  const salt = Buffer.from(saltPart, "base64");
  const expected = Buffer.from(hashPart, "base64");
  if (expected.length !== keyLength) return false;

  const derived = await deriveKey(password, salt);
  // Длины равны по проверке выше, поэтому timingSafeEqual не бросит исключение.
  return timingSafeEqual(derived, expected);
}

let decoyHash: Promise<string> | null = null;

/**
 * Хеш-подмена для несуществующего логина.
 *
 * Это обязательно настоящий scrypt-хеш: verifyPassword сверяет длину второй
 * части с keyLength и возвращает false раньше, чем посчитает scrypt. Заглушка
 * вида "scrypt$...$AAAA" декодируется в 3 байта, проверка длины срабатывает,
 * и время ответа для несуществующего логина оказывалось втрое меньше, чем для
 * существующего, — по нему логины перебирались. С настоящим хешем оба случая
 * стоят одинаково.
 *
 * Считается один раз при первой попытке и кэшируется. При отказе по пределу
 * одновременных вычислений кэш сбрасывается, иначе отказ запомнился бы навсегда.
 */
export function decoyPasswordHash() {
  if (!decoyHash) {
    decoyHash = hashPassword(randomBytes(32).toString("base64url")).catch((error: unknown) => {
      decoyHash = null;
      throw error;
    });
  }
  return decoyHash;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  prisma: PrismaClient,
  userId: string,
  duration: SessionDuration,
  userAgent: string | null
) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionDurations[duration]);
  await prisma.portalSession.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      userAgent: userAgent?.slice(0, 255) ?? null
    }
  });
  return { token, expiresAt };
}

export type SessionUser = {
  id: string;
  login: string;
  displayName: string;
  role: PortalRole;
  createdAt: Date;
};

/**
 * Читает сессию из cookie, проверяет срок и активность пользователя.
 * Возвращает null, если сессии нет или она недействительна.
 */
export async function resolveSession(prisma: PrismaClient, request: FastifyRequest) {
  const token = request.cookies[sessionCookieName];
  if (!token || typeof token !== "string" || token.length < 20) return null;

  const session = await prisma.portalSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true }
  });
  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.portalSession.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  // Учётная запись могли отключить или удалить после выдачи cookie.
  if (!session.user.active) {
    await prisma.portalSession.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }

  // lastSeenAt обновляем не чаще раза в минуту, чтобы не писать в базу на каждый запрос.
  if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
    await prisma.portalSession
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }

  return session;
}

export async function destroySession(prisma: PrismaClient, request: FastifyRequest) {
  const token = request.cookies[sessionCookieName];
  if (token && typeof token === "string") {
    await prisma.portalSession
      .deleteMany({ where: { tokenHash: hashToken(token) } })
      .catch(() => undefined);
  }
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date, secure: boolean) {
  reply.setCookie(sessionCookieName, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    expires: expiresAt
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean) {
  reply.clearCookie(sessionCookieName, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure
  });
}

/**
 * Регистрация по ключу включается переменной REGISTRATION_KEY. Пустое значение
 * означает «регистрация выключена»: заведение новых учётных записей делает
 * скрипт scripts/create-user.ts.
 */
export function isRegistrationKeyEnabled() {
  return config.REGISTRATION_KEY.trim().length > 0;
}

/**
 * Сравнение ключа регистрации постоянного времени, чтобы по времени ответа
 * нельзя было подбирать ключ по частям. Сам ключ в логи не пишется.
 */
export function isRegistrationKeyValid(providedKey: string) {
  const expected = Buffer.from(config.REGISTRATION_KEY.trim(), "utf8");
  if (expected.length === 0) return false;
  const provided = Buffer.from(providedKey, "utf8");
  // Длины разные — сравнивать нечего, timingSafeEqual бросил бы исключение.
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

declare module "fastify" {
  interface FastifyRequest {
    sessionUser?: SessionUser | null;
  }
}

/**
 * Проверка активной сессии. Используется как preHandler для защищённых маршрутов.
 */
export function requireSession(prisma: PrismaClient) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await resolveSession(prisma, request);
    if (!session) {
      return reply.code(401).send({ error: "Требуется вход в портал." });
    }
    request.sessionUser = session.user;
  };
}

/**
 * Проверка роли. Ставится после requireSession: глобальный хук в server.ts уже
 * положил request.sessionUser, но проверка остаётся самостоятельной, чтобы
 * модуль не зависел от порядка регистрации хуков.
 */
export function requireRole(...allowed: PortalRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const role = request.sessionUser?.role;
    if (!role) {
      return reply.code(401).send({ error: "Требуется вход в портал." });
    }
    if (!allowed.includes(role)) {
      return reply.code(403).send({ error: "Этот раздел доступен только администраторам." });
    }
  };
}
