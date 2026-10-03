/**
 * Единая точка HTTP-запросов к API.
 *
 * Зачем отдельный модуль:
 * 1. Cookie сессии отправляется явно (`credentials: "same-origin"`), а не
 *    полагается на поведение браузера по умолчанию. В проде и в dev-запросы
 *    идут на тот же origin (nginx и Vite проксируют /api), поэтому
 *    "same-origin" достаточно и строже, чем "include".
 * 2. Любой 401 от защищённого эндпоинта означает одно: сессия протухла или
 *    была сброшена. Модуль один раз сообщает об этом подписчику, а тот
 *    сбрасывает пользователя в App.tsx и показывает форму входа.
 *
 * Эндпоинты /api/auth/ из обработки исключены: там 401 — штатный ответ
 * (нет сессии, неверный пароль), сбрасывать из-за него нечего.
 */

type SessionExpiredHandler = () => void;

let sessionExpiredHandler: SessionExpiredHandler | null = null;

/**
 * Подписка на сброс сессии. Возвращает функцию отписки для useEffect.
 */
export function onSessionExpired(handler: SessionExpiredHandler) {
  sessionExpiredHandler = handler;
  return () => {
    if (sessionExpiredHandler === handler) sessionExpiredHandler = null;
  };
}

function shouldResetSession(url: string) {
  if (!url.startsWith("/api/")) return false;
  return !url.startsWith("/api/auth/");
}

export async function apiFetch(input: string, init: RequestInit = {}) {
  const response = await fetch(input, {
    ...init,
    credentials: init.credentials ?? "same-origin"
  });

  if (response.status === 401 && shouldResetSession(input)) {
    sessionExpiredHandler?.();
  }

  return response;
}
