import { z } from "zod";

export const commentTemplateSchema = z.object({
  value: z.string().max(10_000)
});

export const commentTemplateTypeSchema = z.enum(["filter", "balancers", "bypasses", "ehw"]);
