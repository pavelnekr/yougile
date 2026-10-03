import { YougileClient } from "./client.js";

export type ChatMessage = {
  text: string;
  timestamp: number | null;
};

/**
 * YouGile отдаёт список сообщений по-разному в зависимости от версии ответа,
 * поэтому массив ищется по нескольким известным ключам.
 */
export function getChatMessages(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const response = value as Record<string, unknown>;
  for (const key of ["content", "messages", "items", "data"]) {
    if (Array.isArray(response[key])) return response[key];
  }
  return [];
}

export function getMessageTimestamp(message: Record<string, unknown>) {
  // У сообщений чатов YouGile отдельного поля времени нет: метка лежит в id (epoch ms).
  for (const key of ["timestamp", "createdAt", "created_at", "date", "time", "id"]) {
    const value = message[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export function getMessageText(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  for (const key of ["text", "message", "textHtml"]) {
    if (typeof message[key] === "string" && message[key].trim()) {
      return message[key].replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n")
        .replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"")
        .trim();
    }
  }
  return null;
}

/** Последнее сообщение чата задачи: нужно для контекста перед отправкой комментария. */
export function pickLatestChatMessage(value: unknown): ChatMessage | null {
  const candidates = getChatMessages(value)
    .filter((message): message is Record<string, unknown> => Boolean(message) && typeof message === "object" && !Array.isArray(message))
    .map((message) => ({ text: getMessageText(message), timestamp: getMessageTimestamp(message) }))
    .filter((message): message is ChatMessage => message.text !== null);
  candidates.sort((left, right) => (right.timestamp ?? -Infinity) - (left.timestamp ?? -Infinity));
  return candidates[0] ?? null;
}

export async function readLatestChatMessage(client: YougileClient, taskId: string): Promise<ChatMessage | null> {
  return pickLatestChatMessage(await client.request(`chats/${encodeURIComponent(taskId)}/messages?limit=100&offset=0`));
}

export async function postChatMessage(client: YougileClient, taskId: string, text: string) {
  await client.request(`chats/${encodeURIComponent(taskId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
}