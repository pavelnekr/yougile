import { apiFetch } from "./apiClient";

/**
 * Сводка активной операции для панели «Идёт операция» на обзоре. Подробные
 * строки (items) страница сценария получает отдельно по GET /api/operations/:id,
 * когда открывает операцию.
 */
export type ActiveOperation = {
  id: string;
  type: "ASSIGN" | "REMOVE" | "COMMENT";
  status: "QUEUED" | "RUNNING";
  total: number;
  completed: number;
  failed: number;
  message: string | null;
};

export async function fetchActiveOperations(signal?: AbortSignal): Promise<ActiveOperation[]> {
  const response = await apiFetch("/api/operations/active", { signal });
  const data = (await response.json()) as { items?: ActiveOperation[]; error?: string };
  if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить активные операции.");
  return data.items ?? [];
}

/**
 * Активная операция нужного типа. Страницы сценариев вызывают это при монтировании,
 * когда своей операции ещё нет: так панель хода восстанавливается после ухода на
 * другой раздел или после перезагрузки страницы — операция уже несколько минут
 * идёт в фоне, а интерфейс возвращается к ней по активным операциям.
 */
export async function findActiveOperation(
  type: ActiveOperation["type"],
  signal?: AbortSignal
): Promise<ActiveOperation | null> {
  const items = await fetchActiveOperations(signal);
  return items.find((operation) => operation.type === type) ?? null;
}