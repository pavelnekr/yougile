import type { PrismaClient } from "@prisma/client";
import { config } from "../../config.js";
import { YougileApiError, type YougileClient } from "../../integrations/yougile/client.js";
import type { PortalColumn } from "./schema.js";

export const planColumnSettingKey = "portal-config:plan-column";
export const avrColumnsSettingKey = "portal-config:avr-columns";

// Значение по умолчанию — колонка из окружения: до первого сохранения портал
// работает ровно так, как работал до появления раздела конфигурации.
export const defaultPlanColumn: PortalColumn = {
  id: config.YOUGILE_PLAN_COLUMN_ID,
  name: "Фильтрация"
};

const columnIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Читает сохранённое значение как столбец. Повреждённая запись не роняет сервис:
// возвращается null, и вызывающий код остаётся на значении по умолчанию.
function readColumn(value: unknown): PortalColumn | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return null;
  const id = candidate.id.trim();
  const name = candidate.name.trim();
  if (!columnIdPattern.test(id) || !name) return null;
  return { id, name };
}

// Текущий столбец плана живёт в памяти процесса: API и очередевой воркер работают
// в одном процессе (см. server.ts), поэтому сохранение видно сразу всем, без
// похода в базу на каждый запрос списка площадок. При старте значение читается
// из БД, дальше обновляется вместе с сохранением настройки.
let planColumn: PortalColumn = defaultPlanColumn;

export function getPlanColumn(): PortalColumn {
  return planColumn;
}

export function setPlanColumn(column: PortalColumn): void {
  planColumn = column;
}

export async function loadPlanColumn(prisma: PrismaClient): Promise<void> {
  const setting = await prisma.appSetting.findUnique({ where: { key: planColumnSettingKey } });
  planColumn = readColumn(setting?.value) ?? defaultPlanColumn;
}

export async function loadAvrColumns(prisma: PrismaClient): Promise<PortalColumn[]> {
  const setting = await prisma.appSetting.findUnique({ where: { key: avrColumnsSettingKey } });
  if (!Array.isArray(setting?.value)) return [];
  const columns: PortalColumn[] = [];
  for (const item of setting.value) {
    const column = readColumn(item);
    if (column) columns.push(column);
  }
  return columns;
}

// Проверка, что колонка с таким ID существует в YouGile и доступна токену из
// запроса. Один дешёвый запрос первых страниц без разбора содержимого: если
// колонки нет, YouGile отвечает 404. Используется при сохранении конфигурации
// (не сохранять заведомо битый ID) и для статуса рядом с полем ID.
export type ColumnCheckResult =
  | { status: "ok" }
  | { status: "not_found" }
  | { status: "error"; reason: string };

export async function checkColumnInYougile(client: YougileClient, columnId: string): Promise<ColumnCheckResult> {
  try {
    await client.request(`task-list?columnId=${encodeURIComponent(columnId)}&limit=1&offset=0`);
    return { status: "ok" };
  } catch (error) {
    if (error instanceof YougileApiError && error.statusCode === 404) {
      return { status: "not_found" };
    }
    if (error instanceof YougileApiError && (error.statusCode === 401 || error.statusCode === 403)) {
      return { status: "error", reason: "токен YouGile не даёт доступа к этому столбцу" };
    }
    return { status: "error", reason: "не удалось связаться с YouGile" };
  }
}
