import { z } from "zod";

export const loginSchema = z.object({
  login: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(256)
});

export type LoginInput = z.infer<typeof loginSchema>;
