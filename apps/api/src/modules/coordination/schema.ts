import { z } from "zod";

// Три подрядчика из формы n8n-воркфлоу. Список закрыт: тема и текст письма
// подставляют имя дословно, и свободный ввод плодил бы опечатки в письмах.
export const contractorOptions = [
  "ООО «Юстас»",
  "ФГУП «НПП Гамма»",
  "ООО «РТК-Сервис»"
] as const;

export const contractorSchema = z.enum(contractorOptions);

// Дата приходит из <input type="date"> значениями вида 2026-10-15.
const workDateSchema = z.string().trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Дата работ должна быть в формате ГГГГ-ММ-ДД.")
  .refine((value) => Number.isFinite(new Date(`${value}T00:00:00`).getTime()), "Укажите корректную дату работ.");

export const previewFieldsSchema = z.object({
  region: z.string().trim()
    .min(1, "Укажите регион.")
    .max(200, "Регион не должен превышать 200 символов."),
  contractor: contractorSchema,
  workDate: workDateSchema
});

// Письмо после предпросмотра: тема и тело редактируются оператором до отправки.
// Тело — HTML (письмо формируется таблицами), поэтому верхняя граница щедрая,
// но ограничена, чтобы в одном запросе нельзя было перегрузить SMTP-сервер.
export const sendLetterSchema = z.object({
  subject: z.string().trim()
    .min(1, "Укажите тему письма.")
    .max(500, "Тема не должна превышать 500 символов."),
  body: z.string().trim()
    .min(1, "Текст письма пуст.")
    .max(100_000, "Текст письма не должен превышать 100 000 символов.")
});

const emailSchema = z.string().trim()
  .min(1, "Адрес не может быть пустым.")
  .max(254, "Адрес слишком длинный.")
  .email("Проверьте адрес электронной почты.");

export const mailRecipientsSchema = z.object({
  recipients: z.array(emailSchema)
    .min(1, "Укажите хотя бы одного получателя.")
    .max(20, "Можно сохранить не больше 20 получателей.")
    .refine(
      (items) => new Set(items.map((item) => item.toLowerCase())).size === items.length,
      "Адреса получателей не должны повторяться."
    )
});

export type PreviewFields = z.infer<typeof previewFieldsSchema>;
export type SendLetter = z.infer<typeof sendLetterSchema>;
