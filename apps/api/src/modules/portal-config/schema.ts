import { z } from "zod";

// YouGile задаёт ID колонки в формате UUID. Сравнение неплотное (без проверки
// версии и варианта): важна форма записи, а не конкретная версия UUID.
const columnIdSchema = z.string().trim()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "ID столбца должен быть в формате UUID.");

const columnNameSchema = z.string().trim()
  .min(1, "Укажите название столбца.")
  .max(80, "Название не должно превышать 80 символов.");

export const planColumnSchema = z.object({
  id: columnIdSchema,
  name: columnNameSchema
});

export const avrColumnsSchema = z.object({
  items: z.array(z.object({ id: columnIdSchema, name: columnNameSchema }))
    .max(100, "Можно сохранить не больше 100 столбцов.")
    .refine(
      (items) => new Set(items.map((item) => item.id.toLowerCase())).size === items.length,
      "ID столбцов в списке не должны повторяться."
    )
});

export type PortalColumn = z.infer<typeof planColumnSchema>;
