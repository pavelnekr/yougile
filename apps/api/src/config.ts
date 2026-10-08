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
  YOUGILE_TOKEN_ENCRYPTION_KEY: z.string().regex(/^(?:[a-fA-F0-9]{64})?$/, "YOUGILE_TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters").default(""),
  // Значение по умолчанию — нейтральный пример: реальный ID колонки живёт в .env
  // (не коммитится) или в «Конфигурация портала» (таблица AppSetting). Чужой ID
  // в репозиторий не кладём.
  YOUGILE_PLAN_COLUMN_ID: z.string().uuid().default("11111111-1111-4111-8111-111111111111"),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024)
});

export const config = envSchema.parse(process.env);
