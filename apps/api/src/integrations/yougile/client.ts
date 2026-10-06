import { config } from "../../config.js";

export class YougileApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly apiMessage?: string
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
  constructor(
    private readonly token: string,
    private readonly options: YougileClientOptions = {}
  ) {}

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
    while (true) {
      response = await fetch(new URL(relativePath, baseUrl), {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(15_000)
      });
      responseText = await response.text();
      if (response.status !== 429 || !this.options.retryOnRateLimit) break;
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }

    if (!response.ok) {
      throw new YougileApiError(
        `YouGile request failed with HTTP ${response.status}`,
        response.status,
        getApiErrorMessage(responseText)
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
