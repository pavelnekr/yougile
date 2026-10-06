import type { FastifyInstance, FastifyRequest } from "fastify";
import type { LogLevel, Prisma, PrismaClient } from "@prisma/client";

/**
 * Журнал действий портала для одноимённого раздела интерфейса.
 *
 * Отдельная таблица вместо stdout-логгера pino: записи должны быть видны
 * администратору в браузере, фильтроваться по уровню, действию и исполнителю и
 * переживать перезапуск процесса, а stdout с каждым перезапуском пропадает.
 *
 * Журнал заполняется в двух местах:
 *  - хуки Fastify (`registerLogHooks`) — каждая мутация и каждый нестандартный
 *    ответ, включая текст ошибки, которую реально получил клиент;
 *  - воркер очереди (`jobs/worker.ts`) — фоновые операции, которых в
 *    HTTP-потоке не видно: они выполняются уже после того, как оператор получил
 *    «202 Accepted».
 *
 * Секреты вырезаются на входе: пароли, токены и ключ регистрации не попадают в
 * журнал ни в каком виде (см. `sanitizePayload`).
 */

// Счётчики отказов журнала. Журнал — вспомогательная подсистема: его
// недоступность (например, база упала) не должна ломать основной запрос и не
// должна заливать консоль строками по одной на каждый запрос.
let logFailures = 0;
let logSilencedUntil = 0;
const logSilenceMs = 60_000;
const logFailuresBeforeSilence = 3;

/** Максимум символов в одной строке сообщения и в тексте ошибки. */
const maxMessageChars = 1000;
const maxErrorChars = 2000;

/** Тела запроса усекаются до разумного размера, чтобы план на 2000 площадок
 * не превращал журнал в копию файла. */
const maxDepth = 5;
const maxArrayItems = 20;
const maxStringChars = 300;
const maxPayloadChars = 4000;
const redacted = "***";

// Ключи, значения которых не должны попасть в журнал. Проверяется имя поля, а
// не значение, поэтому перечислены и полные имена из схемы (`registrationKey`,
// `yougileTokenEncrypted`), и общие корни (`password`, `token`).
const sensitiveKey = /(password|token|secret|registration[_-]?key|authorization|cookie)/i;

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && value.length > maxStringChars) {
      return `${value.slice(0, maxStringChars)}…`;
    }
    return value;
  }
  if (depth >= maxDepth) return "[глубина]";

  if (Array.isArray(value)) {
    const items = value.slice(0, maxArrayItems).map((item) => sanitizeValue(item, depth + 1));
    if (value.length > maxArrayItems) items.push(`… ещё ${value.length - maxArrayItems}`);
    return items;
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    // Ложных срабатываний не боятся: под секретом может оказаться и флаг
    // `yougileTokenConfigured`, но он тоже безвреден, если превратится в звёзды.
    if (sensitiveKey.test(key) && typeof item !== "boolean") {
      result[key] = redacted;
      continue;
    }
    result[key] = sanitizeValue(item, depth + 1);
  }
  return result;
}

/**
 * Тело запроса, пригодное для записи в колонку Json.
 * Возвращает null, если писать нечего, и усечённый вариант, если JSON не влезает
 * в отведенный лимит.
 */
export function sanitizePayload(value: unknown): Prisma.InputJsonValue | null {
  if (value === undefined || value === null) return null;
  try {
    const sanitized = sanitizeValue(value, 0);
    const text = JSON.stringify(sanitized);
    if (text === undefined) return null;
    if (text.length <= maxPayloadChars) return sanitized as Prisma.InputJsonValue;
    return { truncated: true, preview: `${text.slice(0, maxPayloadChars)}…` };
  } catch {
    // Циклическая ссылка или несериализуемое значение — писать нечего.
    return null;
  }
}

export type LogEntry = {
  level?: LogLevel;
  /** Короткий машинный код события, по которому удобно группировать: «POST /api/assignments». */
  action: string;
  /** Текст по-русски, готовый к показу в списке. */
  message: string;
  actorId?: string | null;
  actorLogin?: string | null;
  actorRole?: string | null;
  ip?: string | null;
  method?: string | null;
  path?: string | null;
  status?: number | null;
  durationMs?: number | null;
  request?: unknown;
  error?: string | null;
  entityId?: string | null;
};

/**
 * Запись строки журнала. Никогда не бросает исключение: вызывающий код не должен
 * заботиться о том, что журнал недоступен. При повторных отказах записи в
 * консоль приглушаются на минуту, чтобы падение базы не порождало лавину строк.
 */
export async function recordLog(prisma: PrismaClient, entry: LogEntry): Promise<void> {
  if (Date.now() < logSilencedUntil) return;

  try {
    const request = sanitizePayload(entry.request);
    await prisma.portalLog.create({
      data: {
        level: entry.level ?? "INFO",
        action: entry.action,
        message: entry.message.slice(0, maxMessageChars),
        actorId: entry.actorId ?? null,
        actorLogin: entry.actorLogin ?? null,
        actorRole: entry.actorRole ?? null,
        ip: entry.ip ?? null,
        method: entry.method ?? null,
        path: entry.path ?? null,
        status: entry.status ?? null,
        durationMs: entry.durationMs ?? null,
        error: entry.error ? entry.error.slice(0, maxErrorChars) : null,
        entityId: entry.entityId ?? null,
        // Json-поле не затрагиваем, когда писать нечего: так не приходится
        // выбирать между Prisma.DbNull и Prisma.JsonNull.
        ...(request === null ? {} : { request })
      }
    });
    logFailures = 0;
  } catch (error) {
    logFailures += 1;
    if (logFailures >= logFailuresBeforeSilence) logSilencedUntil = Date.now() + logSilenceMs;
    console.error("Could not write portal log", {
      action: entry.action,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Переопределение текста записи журнала для текущего запроса.
 *
 * Маршруты вызывают его там, где ответ сам по себе ничего не говорит: статус
 * «202» на загрузке файла не сообщает ни имени файла, ни числа строк. Свойство
 * описано ниже, в аугментации модуля fastify.
 */
export function annotateLog(
  request: FastifyRequest,
  annotation: { message?: string; action?: string; level?: LogLevel; entityId?: string }
): void {
  if (annotation.message !== undefined) request.logMessage = annotation.message;
  if (annotation.action !== undefined) request.logAction = annotation.action;
  if (annotation.level !== undefined) request.logLevel = annotation.level;
  if (annotation.entityId !== undefined) request.logEntityId = annotation.entityId;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Текст строки журнала вместо стандартного «Запрос выполнен». */
    logMessage?: string;
    /** Код события вместо «МЕТОД /путь». */
    logAction?: string;
    /** Уровень журнала, если маршрут считает событие важнее, чем статус ответа. */
    logLevel?: LogLevel;
    /** Связанный объект: операция, импорт, учётная запись. */
    logEntityId?: string;
  }
}

/** Ошибки из четырёхсотых ответов: Fastify и приложение отвечают JSON с текстом. */
function messageFromPayload(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { message?: unknown; error?: unknown };
    const text = parsed.message ?? parsed.error;
    if (typeof text === "string" && text.trim().length > 0) return text;
  } catch {
    // Ответ не в JSON — оставляем как есть.
  }
  return payload.slice(0, maxErrorChars);
}

function describeThrown(error: Error): { short: string; detail: string } {
  const short = `${error.name}: ${error.message}`;
  const detail = error.stack ? `${short}\n${error.stack}` : short;
  return { short, detail: detail.slice(0, maxErrorChars) };
}

/**
 * Что имеет смысл сохранить, а что нет.
 *
 * Журнал должен отвечать на два вопроса администратора: «что сотрудник сделал»
 * и «что пошло не так». Отсюда правила:
 *  - мутации пишутся всегда, даже успешные — это действия пользователей;
 *  - любая ошибка пишется в любом методе, включая чтение;
 *  - здоровые GET не пишутся: их в день тысячи (опрос статуса операций,
 *    списки площадок), и в журнале они затопили бы всё остальное;
 *  - пинг `/api/health` идёт из docker healthcheck каждые 10 секунд, поэтому
 *    пишется только если сам отвечает 5xx;
 *  - 401 на путях вне входа — это «сессии нет», обычное состояние страницы
 *    до авторизации, а не событие. Неудачные попытки входа остаются: они идут
 *    по `/api/auth/login`.
 */
function shouldRecord(method: string, pathname: string, status: number, annotated: boolean): boolean {
  if (method === "OPTIONS") return false;
  if (annotated) return true;
  if (pathname.startsWith("/api/health")) return status >= 500;
  if (status === 401 && !pathname.startsWith("/api/auth/login")) return false;
  if (status >= 400) return true;
  return method !== "GET";
}

const startedAt = new WeakMap<FastifyRequest, bigint>();
const thrownErrors = new WeakMap<FastifyRequest, Error>();
const responseMessages = new WeakMap<FastifyRequest, string>();

/**
 * Подключает журнал к HTTP-потоку. Вызывается в server.ts **до** регистрации
 * маршрутов: Fastify фиксирует список хуков в момент создания маршрута, и
 * хук, добавленный позже, к уже созданным маршрутам не применяется.
 */
export function registerLogHooks(app: FastifyInstance, prisma: PrismaClient): void {
  app.addHook("onRequest", async (request) => {
    startedAt.set(request, process.hrtime.bigint());
  });

  app.addHook("onError", async (request, _reply, error) => {
    thrownErrors.set(request, error);
  });

  // Тело ответа с кодом 4xx/5xx — это то, что реально увидел клиент. Без него
  // в журнале остался бы голый статус «400» без причины, а причина обычно
  // лежит в поле `error` или `message` нашего ответа.
  app.addHook("onSend", async (request, reply, payload) => {
    if (reply.statusCode >= 400 && typeof payload === "string" && payload.length > 0) {
      responseMessages.set(request, messageFromPayload(payload));
    }
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    const pathname = request.url.split("?")[0] ?? request.url;
    const method = request.method;
    const status = reply.statusCode;
    const annotated = Boolean(request.logMessage);
    if (!shouldRecord(method, pathname, status, annotated)) return;

    const start = startedAt.get(request);
    // Наносекунды в миллисекунды с одним знаком: разница под миллисекунду
    // интересна при диагностике медленных запросов, целые значения теряют её.
    const durationMs = start ? Math.round(Number(process.hrtime.bigint() - start) / 100_000) / 10 : null;

    const thrown = thrownErrors.get(request);
    const fromPayload = responseMessages.get(request) ?? null;
    const shortError = thrown ? describeThrown(thrown).short : status >= 400 ? fromPayload : null;
    const detailError = thrown ? describeThrown(thrown).detail : fromPayload;

    const level: LogLevel = request.logLevel
      ?? (thrown || status >= 500 ? "ERROR" : status >= 400 ? "WARN" : "INFO");

    const sessionUser = request.sessionUser ?? null;
    let actorLogin = sessionUser?.login ?? null;
    // До входа сессии ещё нет, но попытка входа должна быть видна по логину —
    // иначе в журнале осталась бы анонимная строка о неверном пароле.
    if (!actorLogin && pathname.startsWith("/api/auth/")) {
      const body = request.body as { login?: unknown } | undefined;
      if (typeof body?.login === "string") actorLogin = body.login;
    }

    const route = request.routeOptions?.url;
    const action = request.logAction ?? `${method} ${route ?? pathname}`;
    const message = request.logMessage ?? shortError ?? "Запрос выполнен";

    void recordLog(prisma, {
      level,
      action,
      message,
      actorId: sessionUser?.id ?? null,
      actorLogin,
      actorRole: sessionUser?.role ?? null,
      ip: request.ip,
      method,
      path: pathname,
      status,
      durationMs,
      request: request.body ?? null,
      error: detailError,
      entityId: request.logEntityId ?? null
    });
  });
}

/** Хранение журнала: 30 дней по времени и жёсткий предел по числу строк. */
const retentionDays = 30;
const maxRows = 100_000;
const pruneIntervalMs = 6 * 60 * 60 * 1000;
let pruneTimer: ReturnType<typeof setInterval> | undefined;

async function prune(prisma: PrismaClient): Promise<void> {
  try {
    await prisma.portalLog.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000) } }
    });
    // Время хранения не защищает от всплеска: ошибка в цикле могла бы
    // приносить по строке на каждый запрос неделями. Второй предел —
    // количество строк — закрывает этот сценарий независимо от календаря.
    await prisma.$executeRaw`
      DELETE FROM "PortalLog"
      WHERE "id" IN (
        SELECT "id" FROM "PortalLog"
        ORDER BY "createdAt" DESC
        OFFSET ${maxRows}
      )
    `;
  } catch (error) {
    console.error("Could not prune portal log", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Очистка старых записей. Таймер останавливается в onClose, иначе процесс не
 * завершится: интервал журнала живёт дольше, чем сервер.
 */
export function startLogRetention(prisma: PrismaClient): void {
  if (pruneTimer) return;
  void prune(prisma);
  pruneTimer = setInterval(() => void prune(prisma), pruneIntervalMs);
}

export function stopLogRetention(): void {
  if (!pruneTimer) return;
  clearInterval(pruneTimer);
  pruneTimer = undefined;
}
