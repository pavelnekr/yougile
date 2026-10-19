import type { PrismaClient } from "@prisma/client";
import { config } from "../../config.js";
import { decryptNetboxApiToken } from "../../integrations/yougile/token-crypto.js";

export const netboxSettingKey = "netbox:api-settings";

export type NetboxApiSettings = {
  url: string;
  token: string;
  tokenType: "Bearer" | "Token";
  tokenConfigured: boolean;
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
    tokenConfigured: Boolean(token)
  };
}
