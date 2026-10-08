// Ограничение частоты запросов. Своя реализация вместо
// @fastify/rate-limit: зависимости здесь не добавляются намеренно (см. service.ts),
// а нужна привязка не к маршруту, а к логину — иначе через общий прокси все
// сотрудники попадали бы в один счётчик.
import type { FastifyReply, FastifyRequest } from "fastify";
//
// Счётчики живут в памяти процесса. Это осознанно: несколько экземпляров API
// делили бы внешнее хранилище, но для единственного процесса на сервере
// (docker-compose.prod.yml) состояние в памяти достаточно, а лишних сущностей
// в базе не появляется. Переживать перезапуск нечего — после него счётчики
// обнуляются, и это лишь одна лишняя попытка.

const windowMs = 15 * 60 * 1000;

// Ключи приходят из запроса, поэтому размер карты ограничен сверху. Иначе
// перебор случайных логинов раздувал бы память процесса до перезапуска.
const maxKeys = 20_000;

type Window = { startedAt: number; count: number };

const windows = new Map<string, Window>();
let lastCleanupAt = 0;

function cleanup(now: number) {
  if (now - lastCleanupAt < windowMs) return;
  lastCleanupAt = now;

  for (const [key, window] of windows) {
    if (now - window.startedAt >= windowMs) windows.delete(key);
  }
  // Окно одно на все лимиты, поэтому после чистки протухших ключей остаток
  // упирается только в поток запросов за окно. Если всё же упёрся в предел —
  // сносим самые старые записи: Map хранит их в порядке вставки.
  while (windows.size > maxKeys) {
    const oldest = windows.keys().next();
    if (oldest.done) break;
    windows.delete(oldest.value);
  }
}

export type RateLimitState = {
  /** Сколько секунд ждать до конца окна, если попытка не разрешена. */
  retryAfterSeconds: number;
};

export type RateLimit = {
  /** Сколько неудачных попыток разрешено за окно. */
  limit: number;
  /** Человекочитаемое объяснение, почему попытка отклонена. */
  message: string;
};

/**
 * Читает состояние счётчика, ничего не увеличивая. Вызывается до проверки
 * пароля, чтобы отказать не тратя scrypt.
 */
export function rateLimitState(key: string, limit: RateLimit, now = Date.now()): RateLimitState | null {
  const window = windows.get(key);
  if (!window || now - window.startedAt >= windowMs) return null;
  if (window.count < limit.limit) return null;
  return {
    retryAfterSeconds: Math.max(1, Math.ceil((window.startedAt + windowMs - now) / 1000))
  };
}

/**
 * Учитывает одну попытку. Вход считает только неудачи — десять правильных
 * паролей подряд не приводят к блокировке. Тяжёлые роуты (см. rateLimitPerUser)
 * считают каждый запрос, потому что дорог и сам успешный.
 */
export function recordRateLimit(key: string, now = Date.now()) {
  cleanup(now);
  const window = windows.get(key);
  if (!window || now - window.startedAt >= windowMs) {
    windows.set(key, { startedAt: now, count: 1 });
    return;
  }
  window.count += 1;
}

/** Сбрасывает счётчик: после успешного входа попытки снова разрешены. */
export function clearRateLimit(key: string) {
  windows.delete(key);
}

// Лимиты «тяжёлых» роутов. Оба считаются по пользователю (см. rateLimitPerUser).
//
// Предпросмотр: он перечитывает задачи из YouGile построчно, поэтому и нормальный
// темп оператора, и ускоренный двойными кликами упираются в эти же 30 запросов
// за окно — дальше только вред.
export const previewRateLimit: RateLimit = {
  limit: 30,
  message: "Слишком много предпросмотров подряд. Обновите страницу через несколько минут."
};

// Проверка работ: один запрос синхронно читает чаты всех выбранных площадок
// с паузой 4 секунды — это минуты работы и десятки запросов к YouGile. Пять
// запусков за окно — уже щедро: повторная проверка тех же строк редко нужна.
export const workCheckRateLimit: RateLimit = {
  limit: 5,
  message: "Слишком много запусков проверки работ. Попробуйте через 15 минут."
};

// Отправка письма по SMTP: письмо уходит адресатам сразу и не отзывается,
// поэтому лимит жёсткий. Один оператор редко рассылает больше десяти писем
// за четверть часа, а горячие клики по кнопке «Отправить» не должны
// превращаться в десятки одинаковых писем у получателей.
export const sendLetterRateLimit: RateLimit = {
  limit: 10,
  message: "Слишком много писем подряд. Подождите несколько минут и отправьте снова."
};

/**
 * preHandler, считающий каждый запрос, а не только неудачные попытки.
 *
 * Нужен «тяжёлым» роутам — предпросмотрам и проверке работ: один такой запрос
 * держит соединение минутами и построчно дергает YouGile. Без лимита залогиненный
 * пользователь параллельными запусками перегружает YouGile до ответов 429, и те
 * бьют уже по фоновым операциям всех остальных.
 *
 * Счётчик идёт по сессии, а не по адресу: вход и так невозможен без логина, а
 * за общим прокси IP-лимит блокировал бы всех сотрудников офиса разом — та же
 * причина, по которой логин считает по логину.
 */
export function rateLimitPerUser(limit: RateLimit) {
  return async function heavyRateLimitHook(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Без сессии глобальный хук в server.ts отвечает раньше нас — считать нечего.
    const userId = request.sessionUser?.id;
    if (!userId) return;

    const key = `heavy:${userId}`;
    const blocked = rateLimitState(key, limit);
    if (!blocked) {
      recordRateLimit(key);
      return;
    }

    request.log.warn({ url: request.url, userId }, "Rejected heavy request by rate limit");
    reply.code(429).header("Retry-After", String(blocked.retryAfterSeconds)).send({ error: limit.message });
  };
}