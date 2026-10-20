import type { PrismaClient } from "@prisma/client";
import { config } from "../../config.js";
import { decryptNetboxApiToken } from "../../integrations/yougile/token-crypto.js";

export const netboxSettingKey = "netbox:api-settings";
export const defaultNetboxBypassRoles = ["Комбинированный байпас", "Пассивный байпас"];

export function normalizeNetboxBypassRoles(value: unknown): string[] {
  if (!Array.isArray(value)) return defaultNetboxBypassRoles;
  const roles = [...new Set(value.filter((role): role is string => typeof role === "string").map((role) => role.trim()).filter(Boolean))];
  return roles.length ? roles : defaultNetboxBypassRoles;
}

export type NetboxApiSettings = {
  url: string;
  token: string;
  tokenType: "Bearer" | "Token";
  tokenConfigured: boolean;
  bypassRoles: string[];
};

export async function getNetboxApiSettings(prisma: PrismaClient): Promise<NetboxApiSettings> {
  const setting = await prisma.appSetting.findUnique({ where: { key: netboxSettingKey } });
  const value = setting?.value && typeof setting.value === "object" && !Array.isArray(setting.value)
    ? setting.value as Record<string, unknown> : {};
  const encryptedToken = typeof value.encryptedToken === "string" ? value.encryptedToken : "";
  const token = encryptedToken ? decryptNetboxApiToken(encryptedToken) : config.NETBOX_API_TOKEN;
  const tokenType = value.tokenType === "Token" ? "Token" : value.tokenType === "Bearer" ? "Bearer" : config.NETBOX_API_TOKEN_TYPE;
  return {
    url: typeof value.url === "string" ? value.url : config.NETBOX_API_URL,
    token,
    tokenType,
    tokenConfigured: Boolean(token),
    bypassRoles: normalizeNetboxBypassRoles(value.bypassRoles)
  };
}
