import { PORTAL_VERSION } from "./version";

/**
 * Диагностика ошибок операций: структурированные данные, которые оператор может
 * скопировать из блока «Диагностика для поддержки» и передать разработчику.
 *
 * Типы соответствуют ответу GET /api/operations/:id: пользовательское сообщение
 * живёт в `errorMessage`, а технические детали (describeError с бэкенда) — в
 * `details` элемента и в `errorDetails` операции.
 */
export type ErrorDetail = {
  name?: string;
  message?: string;
  statusCode?: number;
  apiMessage?: string | null;
  responsePreview?: string | null;
  stack?: string;
};

type DiagnosticsOperation = {
  id: string;
  status: string;
  total: number;
  completed: number;
  failed: number;
  message: string | null;
  items: {
    siteId: string;
    status: string;
    errorMessage: string | null;
    label?: string | null;
    details?: ErrorDetail | null;
  }[];
  errorDetails?: ErrorDetail | null;
};

/**
 * Собирает JSON для копирования: что делали, какая операция, что именно не
 * вышло по каждой площадке и какие технические детали прислал YouGile.
 * Вызывается в момент, когда операция завершилась с ошибками.
 */
export function operationDiagnosticsPayload(options: {
  action: string;
  operation: DiagnosticsOperation | null;
  apiError: string | null;
}): Record<string, unknown> {
  const { operation } = options;
  const failedSites = (operation?.items ?? [])
    .filter((item) => item.status === "FAILED")
    .map((item) => ({
      siteId: item.siteId,
      label: item.label ?? null,
      errorMessage: item.errorMessage,
      details: item.details ?? null
    }));

  return {
    portalVersion: PORTAL_VERSION,
    when: new Date().toISOString(),
    action: options.action,
    operationId: operation?.id ?? null,
    operationStatus: operation?.status ?? null,
    operationMessage: operation?.message ?? null,
    counts: operation
      ? {
          total: operation.total,
          completed: operation.completed,
          failed: operation.failed
        }
      : null,
    failedSites,
    operationErrorDetails: operation?.errorDetails ?? null,
    apiError: options.apiError ?? null
  };
}