import type { PrismaClient } from "@prisma/client";
import { decryptYougileToken, YougileTokenEncryptionKeyError } from "./token-crypto.js";
import { YougileClient, type YougileClientOptions } from "./client.js";

export class UserYougileCredentialError extends Error {
  constructor(
    message: string,
    readonly statusCode: 409 | 503
  ) {
    super(message);
    this.name = "UserYougileCredentialError";
  }
}

export class UserYougileTokenMissingError extends UserYougileCredentialError {
  constructor() {
    super("Для вашей учётной записи не настроен токен YouGile. Обратитесь к администратору.", 409);
    this.name = "UserYougileTokenMissingError";
  }
}

export async function getUserYougileClient(
  prisma: PrismaClient,
  userId: string | undefined,
  options?: YougileClientOptions
) {
  if (!userId) throw new UserYougileTokenMissingError();
  const user = await prisma.portalUser.findUnique({
    where: { id: userId },
    select: { active: true, yougileTokenEncrypted: true }
  });
  if (!user?.active || !user.yougileTokenEncrypted) throw new UserYougileTokenMissingError();
  try {
    return new YougileClient(decryptYougileToken(user.yougileTokenEncrypted, userId), options);
  } catch (error) {
    if (error instanceof YougileTokenEncryptionKeyError) {
      throw new UserYougileCredentialError("На сервере не настроен ключ шифрования токенов YouGile.", 503);
    }
    throw error;
  }
}
