import type { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import officeCrypto from "officecrypto-tool";
import { encryptOperatorContacts, decryptOperatorContacts } from "../../integrations/yougile/token-crypto.js";

export const operatorContactsSettingKey = "coordination:operator-contacts";
const maxContactRows = 20_000;

export type OperatorContactRow = {
  region: string;
  site: string;
  siteNumber: string | null;
  operator: string;
  contacts: string;
  emails: string[];
  invalidEmails: string[];
};

export class OperatorContactsLookupError extends Error {
  constructor(
    readonly code: "DIRECTORY_MISSING" | "SITE_MISSING" | "SITE_AMBIGUOUS" | "EMAILS_MISSING" | "EMAILS_INVALID",
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "OperatorContactsLookupError";
  }
}

export function extractSiteNumber(value: string | null): string | null {
  if (!value) return null;
  return value.trim().match(/^(?:ID\s*:?\s*)?(\d+)(?:\b|$)/i)?.[1] ?? null;
}

export type OperatorContactsSnapshot = {
  rows: OperatorContactRow[];
  importedAt: string;
  importedBy: string | null;
};

type StoredContacts = {
  version: 1;
  rowCount: number;
  importedAt: string;
  importedBy: string | null;
  ciphertext: string;
};

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return cell.text.trim() || String(value);
  if (typeof value === "object" && "richText" in value) {
    return value.richText.map((part) => part.text).join("").trim();
  }
  if (typeof value === "object" && "text" in value && typeof value.text === "string") return value.text.trim();
  return String(value).trim();
}

function normalizeHeader(value: string): string {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/[\s\u00a0]+/g, " ").trim();
}

function splitEmails(value: string): { emails: string[]; invalidEmails: string[] } {
  const tokens = value.split(/[;,\n\r]+/).map((part) => part.trim().replace(/^[\s(<]+|[\s)>.:]+$/g, "")).filter(Boolean);
  const emails: string[] = [];
  const invalidEmails: string[] = [];
  const seen = new Set<string>();
  for (const address of tokens) {
    if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(address) || address.length > 254) {
      invalidEmails.push(address);
      continue;
    }
    const key = address.toLocaleLowerCase("en");
    if (!seen.has(key)) {
      seen.add(key);
      emails.push(address);
    }
  }
  return { emails, invalidEmails };
}

export async function parseOperatorContactsWorkbook(buffer: Buffer, password: string): Promise<OperatorContactRow[]> {
  if (!officeCrypto.isEncrypted(buffer)) {
    throw new Error("Файл Excel должен быть защищён паролем на открытие.");
  }

  let workbookBuffer: Buffer;
  try {
    workbookBuffer = await officeCrypto.decrypt(buffer, { password });
  } catch {
    throw new Error("Не удалось расшифровать файл. Проверьте пароль и формат XLSX.");
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(new Uint8Array(workbookBuffer).buffer);
  } catch {
    throw new Error("Не удалось прочитать расшифрованный XLSX. Проверьте формат файла.");
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("В книге нет листов.");
  const headerRow = sheet.getRow(1);
  const headers = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, column) => headers.set(normalizeHeader(cellText(cell)), column));
  const required = ["округ", "площадка", "оператор", "контакты"] as const;
  const missing = required.filter((header) => !headers.has(header));
  if (missing.length) throw new Error(`В первой строке не найдены колонки: ${missing.join(", ")}.`);

  const rows: OperatorContactRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const get = (header: typeof required[number]) => cellText(row.getCell(headers.get(header)!));
    const region = get("округ");
    const site = get("площадка");
    const operator = get("оператор");
    const contacts = get("контакты");
    if (!region && !site && !operator && !contacts) return;
    const siteNumber = site.match(/^\s*(\d+)/)?.[1] ?? null;
    const parsed = splitEmails(contacts);
    rows.push({ region, site, siteNumber, operator, contacts, ...parsed });
    if (rows.length > maxContactRows) throw new Error(`В справочнике больше ${maxContactRows} строк.`);
  });

  if (rows.length === 0) throw new Error("В справочнике нет строк с данными.");
  if (rows.some((row) => !row.siteNumber)) throw new Error("Не удалось извлечь номер площадки из одной или нескольких строк.");
  return rows;
}

function readStored(value: unknown): StoredContacts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stored = value as Record<string, unknown>;
  if (stored.version !== 1 || typeof stored.ciphertext !== "string" || typeof stored.rowCount !== "number" || typeof stored.importedAt !== "string") return null;
  return {
    version: 1,
    rowCount: stored.rowCount,
    importedAt: stored.importedAt,
    importedBy: typeof stored.importedBy === "string" ? stored.importedBy : null,
    ciphertext: stored.ciphertext
  };
}

export async function getOperatorContactsMetadata(prisma: PrismaClient) {
  const setting = await prisma.appSetting.findUnique({ where: { key: operatorContactsSettingKey } });
  const stored = readStored(setting?.value);
  return stored ? { configured: true, rowCount: stored.rowCount, importedAt: stored.importedAt, importedBy: stored.importedBy } : { configured: false, rowCount: 0, importedAt: null, importedBy: null };
}

export async function saveOperatorContacts(prisma: PrismaClient, rows: OperatorContactRow[], importedBy: string | null) {
  const importedAt = new Date().toISOString();
  const ciphertext = encryptOperatorContacts(JSON.stringify(rows));
  const value: StoredContacts = { version: 1, rowCount: rows.length, importedAt, importedBy, ciphertext };
  await prisma.appSetting.upsert({
    where: { key: operatorContactsSettingKey },
    create: { key: operatorContactsSettingKey, value },
    update: { value }
  });
  return { rowCount: rows.length, importedAt, importedBy };
}

export async function clearOperatorContacts(prisma: PrismaClient): Promise<boolean> {
  const result = await prisma.appSetting.deleteMany({ where: { key: operatorContactsSettingKey } });
  return result.count > 0;
}

export async function loadOperatorContacts(prisma: PrismaClient): Promise<OperatorContactsSnapshot | null> {
  const setting = await prisma.appSetting.findUnique({ where: { key: operatorContactsSettingKey } });
  const stored = readStored(setting?.value);
  if (!stored) return null;
  const rows = JSON.parse(decryptOperatorContacts(stored.ciphertext)) as OperatorContactRow[];
  return { rows, importedAt: stored.importedAt, importedBy: stored.importedBy };
}

export async function resolveOperatorRecipients(prisma: PrismaClient, siteNumber: string): Promise<{ recipients: string[]; directoryImportedAt: string }> {
  const snapshot = await loadOperatorContacts(prisma);
  if (!snapshot) {
    throw new OperatorContactsLookupError("DIRECTORY_MISSING", 503, "Справочник email операторов не загружен. Загрузите актуальный XLSX в настройках.");
  }
  const matches = snapshot.rows.filter((row) => row.siteNumber === siteNumber);
  if (matches.length === 0) {
    throw new OperatorContactsLookupError("SITE_MISSING", 404, `Площадка ${siteNumber} не найдена в справочнике email операторов.`);
  }
  if (matches.length > 1) {
    throw new OperatorContactsLookupError("SITE_AMBIGUOUS", 409, `Для площадки ${siteNumber} в справочнике несколько строк. Исправьте справочник и загрузите его повторно.`);
  }

  const row = matches[0]!;
  const invalid = [...row.invalidEmails];
  const recipients: string[] = [];
  const seen = new Set<string>();
  for (const candidate of row.emails) {
    const address = candidate.trim();
    if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(address) || address.length > 254) {
      invalid.push(address);
      continue;
    }
    const key = address.toLocaleLowerCase("en");
    if (!seen.has(key)) {
      seen.add(key);
      recipients.push(address);
    }
  }
  if (invalid.length > 0) {
    throw new OperatorContactsLookupError("EMAILS_INVALID", 422, `Для площадки ${siteNumber} в справочнике есть некорректные email-адреса. Исправьте строку и загрузите файл повторно.`);
  }
  if (recipients.length === 0) {
    throw new OperatorContactsLookupError("EMAILS_MISSING", 422, `Для площадки ${siteNumber} в справочнике не указаны email-адреса.`);
  }
  return { recipients, directoryImportedAt: snapshot.importedAt };
}
