// Ограничение частоты неудачных попыток входа. Своя реализация вместо
// @fastify/rate-limit: зависимости здесь не добавляются намеренно (см. service.ts),
// а нужна привязка не к маршруту, а к логину — иначе через общий прокси все
// сотрудники попадали бы в один счётчик.
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
 * Учитывает одну неудачную попытку. Успешный вход счётчик не трогает, поэтому
 * десять правильных входов подряд не приводят к блокировке.
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