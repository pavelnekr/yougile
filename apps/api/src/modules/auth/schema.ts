import { z } from "zod";

export const loginSchema = z.object({
  login: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(256),
  // Флаг «Запомнить меня»: 30 дней вместо 12 часов.
  rememberMe: z.boolean().optional().default(false)
});

export type LoginInput = z.infer<typeof loginSchema>;

export const registerSchema = z.object({
  login: z
    .string()
    .trim()
    .min(3, "Логин должен быть не короче 3 символов.")
    .max(64, "Логин не должен быть длиннее 64 символов."),
  // Необязательное отображаемое имя: если его не ввели, показываем логин.
  displayName: z
    .string()
    .trim()
    .min(1, "Имя пользователя не может быть пустым.")
    .max(120, "Имя пользователя не должно быть длиннее 120 символов.")
    .optional(),
  password: z
    .string()
    .min(8, "Пароль должен быть не короче 8 символов.")
    .max(256, "Пароль не должен быть длиннее 256 символов."),
  // Ключ, который выдаёт администратор портала. Проверяется в isRegistrationKeyValid.
  registrationKey: z.string().trim().min(1, "Введите ключ регистрации.")
});

export type RegisterInput = z.infer<typeof registerSchema>;
