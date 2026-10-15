import { PrismaClient, type PrismaClient as PrismaClientType } from "@prisma/client";
import type { PrismaClient as PortalPrismaClient } from "@prisma/client";
import { decryptDapsDatabaseUrl } from "../../integrations/yougile/token-crypto.js";

export const dapsDatabaseSettingKey = "daps:database-url";
let cachedUrl = "";
let cachedClient: PrismaClientType | null = null;

export async function getDapsDatabase(prisma: PortalPrismaClient) {
  const setting = await prisma.appSetting.findUnique({ where: { key: dapsDatabaseSettingKey } });
  if (!setting?.value || typeof setting.value !== "object" || Array.isArray(setting.value)) {
    throw new Error("DAPS PostgreSQL не настроен. Укажите параметры подключения в конфигурации портала.");
  }
  const encrypted = (setting.value as Record<string, unknown>).encryptedUrl;
  if (typeof encrypted !== "string" || !encrypted) {
    throw new Error("DAPS PostgreSQL не настроен. Укажите параметры подключения в конфигурации портала.");
  }
  const url = decryptDapsDatabaseUrl(encrypted);
  if (cachedClient && cachedUrl === url) return cachedClient;
  if (cachedClient) await cachedClient.$disconnect();
  cachedUrl = url;
  cachedClient = new PrismaClient({ datasources: { db: { url } } });
  return cachedClient;
}

export async function resetDapsDatabaseClient() {
  if (cachedClient) await cachedClient.$disconnect();
  cachedClient = null;
  cachedUrl = "";
}
