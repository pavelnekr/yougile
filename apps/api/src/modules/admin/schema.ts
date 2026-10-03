import { z } from "zod";

// Роли в UI и API совпадают со значением enum PortalRole.
const portalRoleSchema = z.enum(["ADMIN", "OPERATOR", "VIEWER"]);

export const adminUsersQuerySchema = z.object({
  // Период статистики в днях. "all" — вся история операций.
  days: z.enum(["30", "90", "all"]).default("30")
});

export const createUserSchema = z.object({
  login: z
    .string()
    .trim()
    .min(3, "Логин должен быть не короче 3 символов.")
    .max(64, "Логин не должен быть длиннее 64 символов."),
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
  role: portalRoleSchema.optional()
});

export const updateUserSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1, "Имя пользователя не может быть пустым.")
      .max(120, "Имя пользователя не должно быть длиннее 120 символов.")
      .optional(),
    role: portalRoleSchema.optional(),
    active: z.boolean().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Нет изменений."
  });

export const passwordResetSchema = z.object({
  password: z
    .string()
    .min(8, "Пароль должен быть не короче 8 символов.")
    .max(256, "Пароль не должен быть длиннее 256 символов.")
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
