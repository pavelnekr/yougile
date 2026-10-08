import { createHash } from "node:crypto";
import { config } from "../../config.js";

export class YougileApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly apiMessage?: string,
    readonly responsePreview?: string
  ) {
    super(message);
    this.name = "YougileApiError";
  }
}

function getApiErrorMessage(responseText: string): string | undefined {
  try {
    const value: unknown = JSON.parse(responseText);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

    const record = value as Record<string, unknown>;
    const message = [record.message, record.error, record.description]
      .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
    const cleanedMessage = message?.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
    return cleanedMessage || undefined;
  } catch {
    return undefined;
  }
}

export type YougileClientOptions = {
  retryOnRateLimit?: boolean;
};

export class YougileClient {
  /**
   * Ключ кэша, производный от токена. Токены YouGile персональные, поэтому
   * один общий кэш на процесс отдавал бы данные одного сотрудника другому:
   * администратор прогревает список своим токеном, а оператор получает его же.
   * Хеш от самого токена делает ключ естественным — вызывающему коду не нужно
   * таскать userId вместе с клиентом.
   */
  readonly cacheKey: string;

  constructor(
    private readonly token: string,
    private readonly options: YougileClientOptions = {}
  ) {
    this.cacheKey = createHash("sha256").update(token).digest("hex").slice(0, 16);
  }

  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!this.token) {
      throw new Error("YouGile API token is missing");
    }

    const baseUrl = `${config.YOUGILE_API_URL.replace(/\/+$/, "")}/`;
    const relativePath = path.replace(/^\/+/, "");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    headers.set("Accept", "application/json");

    let response: Response;
    let responseText: string;
    // Повтор только на 429 и только когда он разрешён. Предел нужен обязателен:
    // при залипшем 429 цикл ждал бы по минуте вечно, а воркер очереди с
    // concurrency: 1 остановил бы обработку всех операций. Десять минут ожидания
    // — разумный компромисс: YouGile сбрасывает счётчик быстрее, а зависание
    // недопустимо.
    const maxRateLimitRetries = 10;
    let rateLimitRetries = 0;
    while (true) {
      response = await fetch(new URL(relativePath, baseUrl), {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(15_000)
      });
      responseText = await response.text();
      if (response.status !== 429 || !this.options.retryOnRateLimit) break;
      if (rateLimitRetries >= maxRateLimitRetries) {
        throw new YougileApiError(
          `YouGile kept rate limiting the request after ${maxRateLimitRetries} retries`,
          429,
          getApiErrorMessage(responseText),
          responseText.slice(0, 1000)
        );
      }
      rateLimitRetries += 1;
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }

    if (!response.ok) {
      throw new YougileApiError(
        `YouGile request failed with HTTP ${response.status}`,
        response.status,
        getApiErrorMessage(responseText),
        responseText.slice(0, 1000)
      );
    }

    if (!responseText) return undefined;

    try {
      return JSON.parse(responseText);
    } catch {
      throw new Error("YouGile returned an invalid JSON response");
    }
  }
}
