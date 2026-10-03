import { config } from "../../config.js";

export class YougileApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "YougileApiError";
  }
}

export class YougileClient {
  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!config.YOUGILE_API_TOKEN) {
      throw new Error("YOUGILE_API_TOKEN is not configured");
    }

    const baseUrl = `${config.YOUGILE_API_URL.replace(/\/+$/, "")}/`;
    const relativePath = path.replace(/^\/+/, "");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${config.YOUGILE_API_TOKEN}`);
    headers.set("Accept", "application/json");
    const response = await fetch(new URL(relativePath, baseUrl), {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(15_000)
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new YougileApiError(
        `YouGile request failed with HTTP ${response.status}`,
        response.status
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
