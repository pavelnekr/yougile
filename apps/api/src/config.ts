import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  // Ключ самостоятельной регистрации в портале. Пустое значение не ломает старт
  // API: регистрация просто отключается (см. isRegistrationKeyEnabled).
  REGISTRATION_KEY: z.string().default(""),
  YOUGILE_API_URL: z.string().url(),
  YOUGILE_API_TOKEN: z.string().default(""),
  YOUGILE_PLAN_COLUMN_ID: z.string().uuid().default("951ff78e-1fa5-4334-b34f-288f00609b69"),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024)
});

export const config = envSchema.parse(process.env);
