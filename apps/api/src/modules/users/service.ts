import { z } from "zod";
import { YougileClient } from "../../integrations/yougile/client.js";

const userPageSchema = z.object({
  paging: z.object({
    count: z.number(),
    limit: z.number(),
    offset: z.number(),
    next: z.boolean()
  }),
  content: z.array(z.object({
    id: z.string(),
    realName: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    messengerOnly: z.boolean().nullable().optional()
  }))
});

export type AssignmentUser = {
  id: string;
  name: string;
  status: string | null;
};

const cacheDurationMs = 60_000;
const pageSize = 1000;

async function fetchUsers(client: YougileClient): Promise<AssignmentUser[]> {
  const users: AssignmentUser[] = [];
  let offset = 0;

  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const query = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
    const response = await client.request(`users?${query.toString()}`);
    const parsed = userPageSchema.safeParse(response);

    if (!parsed.success) throw new Error("YouGile returned an unexpected users response");

    users.push(...parsed.data.content
      .filter((user) => !user.messengerOnly && user.status !== "deleted")
      .map((user) => ({
        id: user.id,
        name: user.realName?.trim() || user.email?.trim() || user.id,
        status: user.status ?? null
      })));

    offset = parsed.data.paging.offset + parsed.data.content.length;
    if (!parsed.data.paging.next) return users.sort((left, right) => left.name.localeCompare(right.name, "ru"));
    if (parsed.data.content.length === 0) throw new Error("YouGile users pagination returned an empty page");
    if (pageNumber === 99) throw new Error("YouGile users list exceeded the 100-page safety limit");
  }

  throw new Error("YouGile users pagination did not complete");
}

// Кэш ключуется по YougileClient.cacheKey — хешу токена. Токены YouGile
// персональные: с одним общим ключом администратор прогрел бы кэш своим токеном,
// а оператор получил бы список чужих сотрудников.
const usersCache = new Map<string, { data: AssignmentUser[] | null; expiresAt: number; pending: Promise<AssignmentUser[]> | null }>();

export async function getAssignmentUsers(client: YougileClient): Promise<AssignmentUser[]> {
  const entry = usersCache.get(client.cacheKey) ?? { data: null, expiresAt: 0, pending: null };
  usersCache.set(client.cacheKey, entry);

  if (entry.data && Date.now() < entry.expiresAt) return entry.data;
  if (entry.pending) return entry.pending;

  const pending = fetchUsers(client);
  entry.pending = pending;
  try {
    entry.data = await pending;
    entry.expiresAt = Date.now() + cacheDurationMs;
    return entry.data;
  } finally {
    entry.pending = null;
  }
}
