import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../../config.js";

const nonceBytes = 12;
const authTagBytes = 16;

export class YougileTokenEncryptionKeyError extends Error {
  constructor() {
    super("YOUGILE_TOKEN_ENCRYPTION_KEY must be a 32-byte hexadecimal key");
    this.name = "YougileTokenEncryptionKeyError";
  }
}

function getEncryptionKey() {
  if (!/^[a-fA-F0-9]{64}$/.test(config.YOUGILE_TOKEN_ENCRYPTION_KEY)) {
    throw new YougileTokenEncryptionKeyError();
  }
  return Buffer.from(config.YOUGILE_TOKEN_ENCRYPTION_KEY, "hex");
}

export function encryptYougileToken(token: string, userId: string) {
  const nonce = randomBytes(nonceBytes);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), nonce);
  cipher.setAAD(Buffer.from(`yougile-token:${userId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${nonce.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptYougileToken(value: string, userId: string) {
  const [version, nonceHex, authTagHex, ciphertextHex, extra] = value.split(":");
  if (
    version !== "v1" ||
    !nonceHex || !authTagHex || !ciphertextHex || extra !== undefined ||
    nonceHex.length !== nonceBytes * 2 ||
    authTagHex.length !== authTagBytes * 2 ||
    !/^[a-fA-F0-9]+$/.test(ciphertextHex)
  ) {
    throw new Error("Stored YouGile token has an invalid encrypted format");
  }

  const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), Buffer.from(nonceHex, "hex"));
  decipher.setAAD(Buffer.from(`yougile-token:${userId}`, "utf8"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final()
  ]).toString("utf8");
}
