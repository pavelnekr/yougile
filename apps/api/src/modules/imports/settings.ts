import type { PrismaClient } from "@prisma/client";

// Настройка «Проверки работ»: окно, за которое ищется последний комментарий.
// Живёт в AppSetting, как столбцы «Конфигурации портала»: правка не требует
// миграции и применяется со следующего запуска проверки.
export const workCheckWindowSettingKey = "work-check:window-hours";

// Значение по умолчанию — двое суток (48 часов): до первой правки в
// «Конфигурации портала» проверка работает так, как работала изначально.
export const defaultWorkCheckWindowHours = 48;
export const minWorkCheckWindowHours = 1;
// Верхняя граница — 30 суток: больше читать из чата бессмысленно, а один запрос
// с since всё равно упирается в страницы при большом окне.
export const maxWorkCheckWindowHours = 720;

function normalizeWindowHours(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < minWorkCheckWindowHours || value > maxWorkCheckWindowHours) return null;
  return value;
}

/**
 * Читает окно проверки в часах. Повреждённая или отсутствующая запись не роняет
 * сервис — возвращается значение по умолчанию, и проверка продолжает работать.
 */
export async function loadWorkCheckWindowHours(prisma: PrismaClient): Promise<number> {
  try {
    const setting = await prisma.appSetting.findUnique({ where: { key: workCheckWindowSettingKey } });
    return normalizeWindowHours(setting?.value) ?? defaultWorkCheckWindowHours;
  } catch {
    return defaultWorkCheckWindowHours;
  }
}

export async function saveWorkCheckWindowHours(prisma: PrismaClient, hours: number): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: workCheckWindowSettingKey },
    create: { key: workCheckWindowSettingKey, value: hours },
    update: { value: hours }
  });
}
