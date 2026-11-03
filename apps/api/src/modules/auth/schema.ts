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

export const profileAvatarMaxBytes = 20 * 1024 * 1024;
const avatarDataSchema = z.string().nullable().refine((value) => {
  if (value === null) return true;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length > profileAvatarMaxBytes) return false;
  if (match[1] === "png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (match[1] === "jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
}, "Фото должно быть изображением PNG, JPEG или WebP размером не более 20 МБ.");
export const profileUpdateSchema = z.object({
  displayName: z.string().trim().min(1, "Укажите отображаемое имя.").max(120, "Имя не должно быть длиннее 120 символов.").optional(),
  avatarData: avatarDataSchema.optional()
}).refine((value) => value.displayName !== undefined || value.avatarData !== undefined, "Нет изменений для сохранения.");

export const profilePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8, "Новый пароль должен быть не короче 8 символов.").max(256, "Пароль не должен быть длиннее 256 символов.")
}).refine((value) => value.currentPassword !== value.newPassword, { message: "Новый пароль должен отличаться от текущего." });
