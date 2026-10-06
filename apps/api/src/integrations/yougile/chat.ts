import { YougileClient } from "./client.js";

export type ChatMessage = {
  text: string;
  timestamp: number | null;
};

// Размер страницы сообщений чата. YouGile отдаёт сообщения старыми вперёд,
// поэтому «последний комментарий» нельзя выбирать из первой страницы: при
// длинном чате свежие сообщения лежат на последней странице, а первой сотни
// в ответе нет.
const chatMessagesPageSize = 100;
// Защитный предел числа страниц: у корректного API цикл завершается раньше —
// последняя страница короче pageSize. Предел не даёт запросу крутиться вечно,
// если API вдруг игнорирует limit/offset и возвращает одну и ту же страницу.
const maxChatMessagePages = 100;

/** Все сообщения чата задачи (текст и метка времени), полученные постранично. */
async function readAllChatMessages(client: YougileClient, taskId: string): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  for (let page = 0; page < maxChatMessagePages; page++) {
    const offset = page * chatMessagesPageSize;
    const raw = await client.request(`chats/${encodeURIComponent(taskId)}/messages?limit=${chatMessagesPageSize}&offset=${offset}`);
    const candidates = getChatMessages(raw)
      .filter((message): message is Record<string, unknown> => Boolean(message) && typeof message === "object" && !Array.isArray(message))
      .map((message) => ({ text: getMessageText(message), timestamp: getMessageTimestamp(message) }))
      .filter((message): message is ChatMessage => message.text !== null);
    if (candidates.length === 0) break;
    messages.push(...candidates);
    // Страница короче запрошенного размера — это последняя страница чата.
    if (candidates.length < chatMessagesPageSize) break;
  }
  return messages;
}

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

/** Сообщение с самой поздней меткой времени; если меток нет — первое в порядке ответа. */
function pickLatestChatMessage(messages: ChatMessage[]): ChatMessage | null {
  let latest: ChatMessage | null = null;
  for (const message of messages) {
    if (!latest) {
      latest = message;
      continue;
    }
    const candidate = message.timestamp ?? -Infinity;
    const current = latest.timestamp ?? -Infinity;
    if (candidate > current) latest = message;
  }
  return latest;
}

/** Последнее сообщение чата задачи: нужно для контекста перед отправкой комментария. */
export async function readLatestChatMessage(client: YougileClient, taskId: string): Promise<ChatMessage | null> {
  return pickLatestChatMessage(await readAllChatMessages(client, taskId));
}

export async function postChatMessage(client: YougileClient, taskId: string, text: string) {
  await client.request(`chats/${encodeURIComponent(taskId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
}