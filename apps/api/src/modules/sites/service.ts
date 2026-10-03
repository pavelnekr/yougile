import { z } from "zod";
import { config } from "../../config.js";
import { YougileClient } from "../../integrations/yougile/client.js";
import { extractSiteIdFromTaskTitle } from "./extract-site-id.js";

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  assigned: z.array(z.string()).nullable().optional(),
  archived: z.boolean().nullable().optional(),
  deleted: z.boolean().nullable().optional(),
  completed: z.boolean().nullable().optional(),
  timestamp: z.number().nullable().optional()
});

const taskPageSchema = z.object({
  paging: z.object({
    count: z.number(),
    limit: z.number(),
    offset: z.number(),
    next: z.boolean()
  }),
  content: z.array(taskSchema)
});

export type PlannedSite = {
  taskId: string;
  siteNumber: string;
  title: string;
  assignedCount: number;
  completed: boolean;
  updatedAt: string | null;
};

const pageSize = 1000;
const maxPages = 100;
const cacheDurationMs = 30_000;
let cachedSites: PlannedSite[] | null = null;
let cacheExpiresAt = 0;
let pendingRequest: Promise<PlannedSite[]> | null = null;

async function fetchPlannedSites(client: YougileClient): Promise<PlannedSite[]> {
  const tasks = [];
  let offset = 0;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    const query = new URLSearchParams({
      columnId: config.YOUGILE_PLAN_COLUMN_ID,
      limit: String(pageSize),
      offset: String(offset)
    });
    const response = await client.request(`task-list?${query.toString()}`);
    const parsed = taskPageSchema.safeParse(response);

    if (!parsed.success) {
      throw new Error("YouGile returned an unexpected task-list response");
    }

    tasks.push(...parsed.data.content);
    offset = parsed.data.paging.offset + parsed.data.content.length;

    if (!parsed.data.paging.next) break;
    if (parsed.data.content.length === 0) {
      throw new Error("YouGile task-list pagination returned an empty page");
    }
    if (pageNumber === maxPages - 1) {
      throw new Error(`YouGile task-list exceeded the ${maxPages}-page safety limit`);
    }
  }

  return tasks
    .filter((task) => !task.deleted && !task.archived)
    .flatMap((task) => {
      const siteNumber = extractSiteIdFromTaskTitle(task.title);
      if (!siteNumber) return [];

      return [{
        taskId: task.id,
        siteNumber,
        title: task.title,
        assignedCount: task.assigned?.length ?? 0,
        completed: task.completed ?? false,
        updatedAt: task.timestamp ? new Date(task.timestamp).toISOString() : null
      }];
    })
    .sort((left, right) => {
      const numberDifference = Number(left.siteNumber) - Number(right.siteNumber);
      return numberDifference || left.title.localeCompare(right.title, "ru");
    });
}

export async function getPlannedSites(client: YougileClient): Promise<PlannedSite[]> {
  if (cachedSites && Date.now() < cacheExpiresAt) return cachedSites;
  if (pendingRequest) return pendingRequest;

  pendingRequest = fetchPlannedSites(client);
  try {
    const sites = await pendingRequest;
    cachedSites = sites;
    cacheExpiresAt = Date.now() + cacheDurationMs;
    return sites;
  } finally {
    pendingRequest = null;
  }
}
