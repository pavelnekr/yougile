import type { Prisma, PrismaClient } from "@prisma/client";
import { config } from "../../config.js";
import { YougileApiError, type YougileClient } from "../../integrations/yougile/client.js";
import { decryptPortalColumnId, encryptPortalColumnId, type PortalColumnScope } from "../../integrations/yougile/token-crypto.js";
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
function readColumn(value: unknown, scope: PortalColumnScope): PortalColumn | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return null;
  const storedId = candidate.id.trim();
  const id = storedId.startsWith("v1:") ? decryptPortalColumnId(storedId, scope) : storedId;
  const name = candidate.name.trim();
  if (!columnIdPattern.test(id) || !name) return null;
  return { id, name };
}

function isEncryptedColumnId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("v1:");
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
  const stored = setting?.value && typeof setting.value === "object" && !Array.isArray(setting.value)
    ? setting.value as Record<string, unknown>
    : null;
  const column = readColumn(setting?.value, "plan");
  planColumn = column ?? defaultPlanColumn;
  if (column && stored && !isEncryptedColumnId(stored.id)) {
    const encryptedPlanColumn = { ...stored, id: encryptPortalColumnId(column.id, "plan") };
    await prisma.appSetting.upsert({
      where: { key: planColumnSettingKey },
      create: { key: planColumnSettingKey, value: encryptedPlanColumn },
      update: { value: encryptedPlanColumn }
    });
  }
}

export async function loadAvrColumns(prisma: PrismaClient): Promise<PortalColumn[]> {
  const setting = await prisma.appSetting.findUnique({ where: { key: avrColumnsSettingKey } });
  if (!Array.isArray(setting?.value)) return [];
  const columns: PortalColumn[] = [];
  let needsEncryption = false;
  const migrated = setting.value.map((item) => {
    const column = readColumn(item, "avr");
    if (column) columns.push(column);
    if (!column || typeof item !== "object" || item === null || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    if (isEncryptedColumnId(record.id)) return item;
    needsEncryption = true;
    return { ...record, id: encryptPortalColumnId(column.id, "avr") };
  });
  if (needsEncryption) {
    await prisma.appSetting.upsert({
      where: { key: avrColumnsSettingKey },
      create: { key: avrColumnsSettingKey, value: migrated as unknown as Prisma.InputJsonValue },
      update: { value: migrated as unknown as Prisma.InputJsonValue }
    });
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
