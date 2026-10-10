import type { PrismaClient } from "@prisma/client";
import mammoth from "mammoth";
import nodemailer from "nodemailer";
import { config } from "../../config.js";
import { decryptSmtpPassword, encryptSmtpPassword } from "../../integrations/yougile/token-crypto.js";
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

// Параметры SMTP тоже живут в AppSetting (см. smtpSettingsSettingKey) и
// редактируются в «Конфигурации портала» → «Оповещения», а не в файлах
// окружения. Пароль никуда не возвращается через API, а в БД хранится
// зашифрованным AES-256-GCM тем же ключом, что и токены YouGile.
export type SmtpSettings = {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
};

// Как пароль лежит в AppSetting: зашифрованным (новые сохранения) или открытым
// (легаси-записи, сохранённые до появления шифрования). Открытый пароль
// перешифровывается при следующем сохранении.
export type StoredSmtpPassword =
  | { kind: "encrypted"; value: string }
  | { kind: "plain"; value: string };

export type StoredSmtpSettings = {
  host: string;
  port: number;
  user: string;
  from: string;
  password: StoredSmtpPassword | null;
};

// Ключ настройки параметров SMTP.
export const smtpSettingsSettingKey = "coordination:smtp-settings";

// Значение по умолчанию — переменные окружения SMTP_*: пока администратор ничего
// не сохранил в «Конфигурации портала», портал работает ровно как раньше.
export const defaultSmtpSettings: SmtpSettings = {
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  user: config.SMTP_USER,
  password: config.SMTP_PASSWORD,
  from: config.SMTP_FROM
};

function normalizePort(value: unknown): number {
  const port = typeof value === "number" ? value : Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 465;
}

// Повреждённая запись не роняет сервис: параметры остаются на значении по умолчанию.
function readStoredSmtpSettings(value: unknown): StoredSmtpSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.host !== "string") return null;

  let password: StoredSmtpPassword | null = null;
  const rawPassword = candidate.password;
  if (typeof rawPassword === "string" && rawPassword.length > 0) {
    // Легаси: до появления шифрования пароль сохранялся открытой строкой.
    password = { kind: "plain", value: rawPassword };
  } else if (rawPassword && typeof rawPassword === "object" && !Array.isArray(rawPassword)) {
    const stored = rawPassword as Record<string, unknown>;
    if (stored.kind === "encrypted" && typeof stored.value === "string" && stored.value.length > 0) {
      password = { kind: "encrypted", value: stored.value };
    }
  }

  return {
    host: candidate.host.trim(),
    port: normalizePort(candidate.port),
    user: typeof candidate.user === "string" ? candidate.user.trim() : "",
    from: typeof candidate.from === "string" ? candidate.from.trim() : "",
    password
  };
}

function decodeStoredPassword(stored: StoredSmtpPassword | null, log?: (message: string) => void): string {
  if (!stored) return "";
  if (stored.kind === "plain") return stored.value;
  try {
    return decryptSmtpPassword(stored.value);
  } catch (error) {
    log?.(`Could not decrypt stored SMTP password: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

export async function loadSmtpSettings(prisma: PrismaClient, log?: (message: string) => void): Promise<SmtpSettings> {
  try {
    const setting = await prisma.appSetting.findUnique({ where: { key: smtpSettingsSettingKey } });
    const stored = readStoredSmtpSettings(setting?.value);
    if (!stored) return defaultSmtpSettings;
    return {
      host: stored.host,
      port: stored.port,
      user: stored.user,
      from: stored.from,
      password: decodeStoredPassword(stored.password, log)
    };
  } catch {
    return defaultSmtpSettings;
  }
}

// Пароль шифруется перед записью. Если ключ шифрования (YOUGILE_TOKEN_ENCRYPTION_KEY)
// не задан, бросается YougileTokenEncryptionKeyError — маршрут отдаёт понятную
// ошибку, чтобы секрет не ушёл в БД открытым текстом.
export async function saveSmtpSettings(prisma: PrismaClient, settings: SmtpSettings): Promise<void> {
  const stored: StoredSmtpSettings = {
    host: settings.host,
    port: settings.port,
    user: settings.user,
    from: settings.from,
    password: settings.password
      ? { kind: "encrypted", value: encryptSmtpPassword(settings.password) }
      : null
  };
  await prisma.appSetting.upsert({
    where: { key: smtpSettingsSettingKey },
    create: { key: smtpSettingsSettingKey, value: stored },
    update: { value: stored }
  });
}

export function isSmtpConfigured(settings: SmtpSettings): boolean {
  return settings.host.length > 0;
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
 * Отправляет письмо по SMTP. Настройки передаются из AppSetting (или значений по
 * умолчанию из окружения). Ошибки транспорта оборачиваются в понятный русский
 * текст для оператора, детали уходят в лог сервера.
 */
export async function sendLetter(letter: SendLetter, recipients: string[], settings: SmtpSettings): Promise<SendResult> {
  if (!isSmtpConfigured(settings)) {
    throw new Error("SMTP не настроен: укажите SMTP_HOST в настройках портала.");
  }
  if (recipients.length === 0) {
    throw new Error("Нет получателей: добавьте адреса в разделе «Конфигурация портала».");
  }

  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.port === 465,
    ...(settings.user
      ? { auth: { user: settings.user, pass: settings.password } }
      : {}),
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000
  });

  try {
    const info = await transport.sendMail({
      from: settings.from || settings.user,
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
