import { z } from "zod";

/** Поля строки плана для POST/PATCH. Пустые строки нормализуются в null. */
export const planRowFieldsSchema = z.object({
  planDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Дата в формате ГГГГ-ММ-ДД.").nullable().optional(),
  shift: z.string().max(60).nullable().optional(),
  timeWindow: z.string().max(60).nullable().optional(),
  siteId: z.string().max(60).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  po: z.string().max(200).nullable().optional(),
  comment: z.string().max(2000).nullable().optional(),
  engineer: z.string().max(200).nullable().optional(),
  comment2: z.string().max(2000).nullable().optional(),
  status: z.string().max(100).nullable().optional(),
  cluster: z.string().max(200).nullable().optional(),
  free1: z.string().max(200).nullable().optional(),
  free2: z.string().max(200).nullable().optional(),
  free3: z.string().max(200).nullable().optional()
});

export type PlanRowInput = z.infer<typeof planRowFieldsSchema>;

/** Публичный вид строки для ответа клиенту. */
export const planRowSchema = planRowFieldsSchema.extend({
  id: z.string(),
  sortOrder: z.number(),
  createdById: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type PlanRow = z.infer<typeof planRowSchema>;

/** Параметры фильтрации из query string. */
export const planFiltersSchema = z.object({
  q: z.string().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  shift: z.string().optional(),              // CSV
  time: z.string().optional(),
  siteId: z.string().optional(),
  address: z.string().optional(),
  engineer: z.string().optional(),           // CSV
  status: z.string().optional(),             // CSV
  cluster: z.string().optional(),            // CSV
  po: z.string().optional(),                 // CSV
  free1: z.string().optional(),
  free2: z.string().optional(),
  free3: z.string().optional(),
  incomplete: z.string().optional(),         // CSV: field names (siteId,address,engineer,status)
  sort: z.string().optional(),
  dir: z.enum(["asc", "desc"]).optional()
});

export type PlanFilters = z.infer<typeof planFiltersSchema>;

/** Ответ со списком строк и опциями для фильтров. */
export const planListResponseSchema = z.object({
  items: z.array(planRowSchema),
  total: z.number(),
  filtered: z.number(),
  options: z.object({
    shift: z.array(z.string()),
    engineer: z.array(z.string()),
    status: z.array(z.string()),
    cluster: z.array(z.string()),
    po: z.array(z.string())
  })
});

export type PlanListResponse = z.infer<typeof planListResponseSchema>;