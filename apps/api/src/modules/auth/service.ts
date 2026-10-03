// Хеширование паролей и управление сессиями на встроенном node:crypto.
// Зависимости не добавляются намеренно: node_modules в контейнере перекрыт volume,
// поэтому новая библиотека потребовала бы пересборки образа.
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PortalRole, PrismaClient } from "@prisma/client";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const keyLength = 64;
const saltBytes = 16;
// scrypt дорогой: память ~16 МБ на попытку. Лимит нужен, чтобы злоумышленник
// не мог отправлять подбор пароля параллельно и исчерпать память процесса.
const concurrentHashes = new Set<Promise<unknown>>();

export const sessionCookieName = "portal_session";

export type SessionDuration = "short" | "long";
export const sessionDurations: Record<SessionDuration, number> = {
  short: 12 * 60 * 60 * 1000,
  long: 30 * 24 * 60 * 60 * 1000
};

export function hashPassword(password: string) {
  const salt = randomBytes(saltBytes);
  const promise = scryptAsync(password.normalize("NFKC"), salt, keyLength);
  concurrentHashes.add(promise);
  return promise
    .then((derived) => `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`)
    .finally(() => {
      concurrentHashes.delete(promise);
    });
}

export async function verifyPassword(password: string, storedHash: string) {
  const [algorithm, saltPart, hashPart] = storedHash.split("$");
  if (algorithm !== "scrypt" || !saltPart || !hashPart) return false;

  const salt = Buffer.from(saltPart, "base64");
  const expected = Buffer.from(hashPart, "base64");
  if (expected.length !== keyLength) return false;

  const derived = await scryptAsync(password.normalize("NFKC"), salt, keyLength);
  // Длины равны по проверке выше, поэтому timingSafeEqual не бросит исключение.
  return timingSafeEqual(derived, expected);
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
