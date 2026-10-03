import { z } from "zod";

export const loginSchema = z.object({
  login: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(256),
  // Флаг «Запомнить меня»: 30 дней вместо 12 часов.
  rememberMe: z.boolean().optional().default(false)
});

export type LoginInput = z.infer<typeof loginSchema>;
