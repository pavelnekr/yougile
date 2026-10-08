import type { PrismaClient } from "@prisma/client";
import mammoth from "mammoth";
import nodemailer from "nodemailer";
import { config } from "../../config.js";
import { buildLetter, parseLetterSource, type BuiltLetter } from "./letter.js";
import type { PreviewFields, SendLetter } from "./schema.js";

// Ключ настройки со списком получателей. Живёт в AppSetting, как и столбцы
// «Конфигурации портала»: правка не требует миграции и применяется сразу.
export const mailRecipientsSettingKey = "coordination:mail-recipients";

// Получатели по умолчанию — те же адреса, что были зашиты в n8n-воркфлоу.
// Пока их никто не менял, письмо уходит тем же людям, что и раньше.
export const defaultMailRecipients = ["p.nekrasov@dcoa.ru", "e.kurilenko@dcoa.ru"];

function normalizeRecipients(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const recipients = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (recipients.length === 0 || recipients.length > 20) return null;
  return [...new Set(recipients.map((item) => item.trim()))];
}

/**
 * Читает список получателей из БД. Повреждённая или отсутствующая запись
 * не роняет сервис — возвращаются получатели по умолчанию из воркфлоу.
 */
export async function loadMailRecipients(prisma: PrismaClient): Promise<string[]> {
  try {
    const setting = await prisma.appSetting.findUnique({ where: { key: mailRecipientsSettingKey } });
    const stored = normalizeRecipients(setting?.value);
    return stored ?? [...defaultMailRecipients];
  } catch {
    return [...defaultMailRecipients];
  }
}

export async function saveMailRecipients(prisma: PrismaClient, recipients: string[]): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: mailRecipientsSettingKey },
    create: { key: mailRecipientsSettingKey, value: recipients },
    update: { value: recipients }
  });
}

export function isSmtpConfigured(): boolean {
  return config.SMTP_HOST.length > 0;
}

/**
 * Разбирает DOCX и собирает письмо. Mammoth превращает документ в HTML —
 * дальше работают те же регулярные выражения, что и в n8n.
 */
export async function buildLetterFromDocx(buffer: Buffer, fields: PreviewFields): Promise<BuiltLetter> {
  const converted = await mammoth.convertToHtml({ buffer });
  const source = parseLetterSource(converted.value);
  return buildLetter(source, fields);
}

export type SendResult = {
  messageId: string | null;
  recipientCount: number;
};

/**
 * Отправляет письмо по SMTP. Ошибки транспорта оборачиваются в понятный
 * русский текст для оператора, детали уходят в лог сервера.
 */
export async function sendLetter(letter: SendLetter, recipients: string[]): Promise<SendResult> {
  if (!isSmtpConfigured()) {
    throw new Error("SMTP не настроен: укажите SMTP_HOST в переменных окружения портала.");
  }
  if (recipients.length === 0) {
    throw new Error("Нет получателей: добавьте адреса в разделе «Конфигурация портала».");
  }

  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    ...(config.SMTP_USER
      ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } }
      : {}),
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000
  });

  try {
    const info = await transport.sendMail({
      from: config.SMTP_FROM || config.SMTP_USER,
      to: recipients.join(", "),
      subject: letter.subject,
      html: letter.body
    });
    return { messageId: info.messageId ?? null, recipientCount: recipients.length };
  } finally {
    transport.close();
  }
}

/** Ошибка SMTP для оператора: технические детали остаются в логе сервера. */
export function describeSendError(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("SMTP не настроен")) return error.message;
  if (error instanceof Error && error.message.startsWith("Нет получателей")) return error.message;
  return "Не удалось отправить письмо по SMTP. Проверьте настройки почты в переменных окружения.";
}
