import { z } from "zod";

// Уровни совпадают с enum LogLevel в Prisma-схеме.
const logLevelSchema = z.enum(["INFO", "WARN", "ERROR"]);

/**
 * Параметры списка журнала.
 *
 * Пустые значения не превращаем в фильтр по пустой строке: клиент опускает
 * неиспользуемые параметры, а если он прислал их — это ошибка вызывающего кода
 * и её честнее показать, чем молча вернуть пустой список.
 */
export const logsQuerySchema = z.object({
  level: logLevelSchema.optional(),
  actor: z.string().trim().min(1).max(100).optional(),
  action: z.string().trim().min(1).max(200).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  // Идентификатор последней показанной строки — курсор вместо offset: записи
  // добавляются в голову списка, и смещение посреди выгрузки пропускало бы
  // или дублировало строки.
  before: z.string().min(1).max(40).optional()
});
