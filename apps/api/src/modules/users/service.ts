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
let cachedUsers: AssignmentUser[] | null = null;
let cacheExpiresAt = 0;
let pendingRequest: Promise<AssignmentUser[]> | null = null;

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

export async function getAssignmentUsers(client: YougileClient): Promise<AssignmentUser[]> {
  if (cachedUsers && Date.now() < cacheExpiresAt) return cachedUsers;
  if (pendingRequest) return pendingRequest;

  pendingRequest = fetchUsers(client);
  try {
    cachedUsers = await pendingRequest;
    cacheExpiresAt = Date.now() + cacheDurationMs;
    return cachedUsers;
  } finally {
    pendingRequest = null;
  }
}

export function invalidateAssignmentUsersCache() {
  cachedUsers = null;
  cacheExpiresAt = 0;
}
