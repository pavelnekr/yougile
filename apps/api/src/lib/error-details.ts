import { YougileApiError } from "../integrations/yougile/client.js";

/**
 * Структурированные технические детали ошибки для диагностики.
 *
 * Пишутся в `afterData.error` элемента операции и в `metadata.error` операции,
 * а фронтенд показывает их в блоке «Диагностика для поддержки» с кнопкой
 * «Скопировать» — оператор может передать эти данные разработчику без ручного
 * описания. При этом пользовательское сообщение (`errorMessage`) остаётся
 * короткой русской фразой, как требует правило «технические детали — не в ответ
 * клиенту».
 *
 * Секретов здесь нет: текст ответа YouGile обрезается до превью, токены в тело
 * ответа не входят.
 */
export type ErrorDetails = {
  name: string;
  message: string;
  statusCode?: number;
  apiMessage?: string | null;
  responsePreview?: string | null;
  stack?: string;
};

export function describeError(error: unknown): ErrorDetails {
  const source = error instanceof Error ? error : new Error(String(error));
  const details: ErrorDetails = {
    name: source.name || "Error",
    message: source.message
  };
  if (error instanceof YougileApiError) {
    details.statusCode = error.statusCode;
    details.apiMessage = error.apiMessage ?? null;
    details.responsePreview = error.responsePreview ?? null;
  }
  if (source.stack) details.stack = source.stack.slice(0, 2000);
  return details;
}