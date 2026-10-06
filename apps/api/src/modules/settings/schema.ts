import { z } from "zod";

export const commentTemplateSchema = z.object({
  value: z.string().max(10_000)
});

export const createCommentTemplateSchema = z.object({
  label: z.string().trim().min(1, "Укажите название шаблона.").max(80, "Название не должно превышать 80 символов."),
  value: z.string().max(10_000, "Шаблон не должен превышать 10 000 символов.").default("")
});

export const builtInCommentTemplateTypeSchema = z.enum(["filter", "balancers", "bypasses", "ehw"]);
export const commentTemplateTypeSchema = z.union([
  builtInCommentTemplateTypeSchema,
  z.string().regex(/^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
]);
