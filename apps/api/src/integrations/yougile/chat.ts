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

/** Диагностика одной страницы чата: размер ответа API и число сообщений с текстом. */
export type ChatReadPageDiagnostics = {
  page: number;
  offset: number;
  /** Сколько сообщений вернул API на этой странице (до фильтра по тексту). */
  rawCount: number;
  /** Сколько из них имеют непустой текст и попали в кандидатов. */
  textCount: number;
};

/**
 * Диагностика чтения чата задачи. Нужна, чтобы по логам прода разобраться,
 * почему «Проверка работ» на части площадок не находит последний комментарий:
 * страница могла оборваться раньше конца чата (на ней оказались только вложения
 * с пустым текстом), либо YouGile отвечал ошибками.
 */
export type ChatReadDiagnostics = {
  taskId: string;
  pagesRead: number;
  rawMessages: number;
  textMessages: number;
  emptyTextMessages: number;
  /** Почему чтение остановилось: пустая страница, страница короче запрошенного
   *  размера (по сообщениям с текстом) или упёрлись в защитный предел страниц. */
  stopReason: "empty-page" | "short-page" | "max-pages";
  /** Остановились на странице, где API вернул полную страницу, но сообщений с
   *  текстом было меньше предела — признак преждевременной остановки: дальше
   *  могли быть ещё страницы и более свежие комментарии. */
  stoppedOnFullRawPage: boolean;
  pages: ChatReadPageDiagnostics[];
  latestTimestamp: number | null;
  latestTextLength: number;
  latestTextPreview: string;
  durationMs: number;
};

export type ChatLatestReadResult = {
  latest: ChatMessage | null;
  diagnostics: ChatReadDiagnostics;
};

type ChatReadTrace = {
  pages: ChatReadPageDiagnostics[];
  rawTotal: number;
  textTotal: number;
  stopReason: ChatReadDiagnostics["stopReason"];
  stoppedOnFullRawPage: boolean;
  pagesRead: number;
};

/** Все сообщения чата задачи (текст и метка времени), полученные постранично. */
async function readAllChatMessages(client: YougileClient, taskId: string): Promise<{ messages: ChatMessage[]; trace: ChatReadTrace }> {
  const trace: ChatReadTrace = {
    pages: [],
    rawTotal: 0,
    textTotal: 0,
    stopReason: "max-pages",
    stoppedOnFullRawPage: false,
    pagesRead: 0
  };
  const messages: ChatMessage[] = [];
  for (let page = 0; page < maxChatMessagePages; page++) {
    const offset = page * chatMessagesPageSize;
    const raw = await client.request(`chats/${encodeURIComponent(taskId)}/messages?limit=${chatMessagesPageSize}&offset=${offset}`);
    const rawMessages = getChatMessages(raw);
    const rawCount = rawMessages.length;
    const candidates = rawMessages
      .filter((message): message is Record<string, unknown> => Boolean(message) && typeof message === "object" && !Array.isArray(message))
      .map((message) => ({ text: getMessageText(message), timestamp: getMessageTimestamp(message) }))
      .filter((message): message is ChatMessage => message.text !== null);
    const textCount = candidates.length;
    trace.pages.push({ page, offset, rawCount, textCount });
    trace.pagesRead += 1;
    trace.rawTotal += rawCount;
    trace.textTotal += textCount;
    // Остановка считается по числу сообщений с текстом. Признак преждевременной
    // остановки — полная страница от API (rawCount === pageSize), на которую
    // попали только вложения: чат на ней ещё не закончился, а читать дальше мы
    // не пойдём. На продакшене такие случаи должны всплывать в логах как
    // stoppedOnFullRawPage: true.
    if (textCount === 0) {
      trace.stopReason = "empty-page";
      trace.stoppedOnFullRawPage = rawCount === chatMessagesPageSize;
      break;
    }
    messages.push(...candidates);
    if (textCount < chatMessagesPageSize) {
      trace.stopReason = "short-page";
      trace.stoppedOnFullRawPage = rawCount === chatMessagesPageSize;
      break;
    }
  }
  return { messages, trace };
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

/**
 * Последнее сообщение чата задачи с диагностикой чтения. Используется в
 * «Проверке работ»: результат чтения логируется постранично, чтобы в проде
 * было видно, где именно теряется последний комментарий.
 */
export async function readLatestChatMessageDetailed(client: YougileClient, taskId: string): Promise<ChatLatestReadResult> {
  const startedAt = Date.now();
  const { messages, trace } = await readAllChatMessages(client, taskId);
  const latest = pickLatestChatMessage(messages);
  return {
    latest,
    diagnostics: {
      taskId,
      pagesRead: trace.pagesRead,
      rawMessages: trace.rawTotal,
      textMessages: trace.textTotal,
      emptyTextMessages: trace.rawTotal - trace.textTotal,
      stopReason: trace.stopReason,
      stoppedOnFullRawPage: trace.stoppedOnFullRawPage,
      pages: trace.pages,
      latestTimestamp: latest?.timestamp ?? null,
      latestTextLength: latest?.text.length ?? 0,
      latestTextPreview: latest ? latest.text.slice(0, 80) : "",
      durationMs: Date.now() - startedAt
    }
  };
}

/** Последнее сообщение чата задачи: нужно для контекста перед отправкой комментария. */
export async function readLatestChatMessage(client: YougileClient, taskId: string): Promise<ChatMessage | null> {
  return (await readLatestChatMessageDetailed(client, taskId)).latest;
}

export async function postChatMessage(client: YougileClient, taskId: string, text: string) {
  await client.request(`chats/${encodeURIComponent(taskId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
}