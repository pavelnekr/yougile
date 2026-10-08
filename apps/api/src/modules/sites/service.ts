import { z } from "zod";
import { YougileClient } from "../../integrations/yougile/client.js";
import { getPlanColumn } from "../portal-config/service.js";
import type { PortalColumn } from "../portal-config/schema.js";
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

type YougileTask = z.infer<typeof taskSchema>;

// Обход страниц task-list нужен и списку площадок, и подсчёту по столбцам АВР,
// поэтому пагинация живёт в одной функции, а колонка задаётся параметром.
async function fetchColumnTasks(client: YougileClient, columnId: string): Promise<YougileTask[]> {
  const tasks: YougileTask[] = [];
  let offset = 0;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    const query = new URLSearchParams({
      columnId,
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

  return tasks;
}

// Площадка — задача без признаков удаления/архива, чей заголовок начинается с
// номера площадки. Это ровно то правило, по которому собирается список «Площадки».
function countSites(tasks: YougileTask[]): number {
  let count = 0;
  for (const task of tasks) {
    if (task.deleted || task.archived) continue;
    if (extractSiteIdFromTaskTitle(task.title)) count += 1;
  }
  return count;
}

function toPlannedSites(tasks: YougileTask[]): PlannedSite[] {
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

async function fetchPlannedSites(client: YougileClient): Promise<PlannedSite[]> {
  return toPlannedSites(await fetchColumnTasks(client, getPlanColumn().id));
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

// Смена столбца плана в конфигурации делает накопленный кэш устаревшим:
// в нём лежат задачи из старой колонки. Вызывается из модуля portal-config
// сразу после сохранения нового значения.
export function invalidateSitesCache(): void {
  cachedSites = null;
  cacheExpiresAt = 0;
}

export type AvrColumnCount = { id: string; name: string; count: number };
export type AvrSitesCount = { columns: AvrColumnCount[]; total: number };

// Подсчёт площадок по столбцам АВР из «Конфигурации портала». Кэш ключуется
// полным списком столбцов: как только администратор поменял ID, прежний
// результат по старым колонкам становится невалидным и не отдаётся.
const avrCountDurationMs = 30_000;
let cachedAvrCount: { key: string; data: AvrSitesCount } | null = null;
let avrCountExpiresAt = 0;
let pendingAvrCount: Promise<AvrSitesCount> | null = null;
let pendingAvrCountKey: string | null = null;

export async function getAvrSitesCount(
  client: YougileClient,
  columns: PortalColumn[]
): Promise<AvrSitesCount> {
  const key = columns.map((column) => `${column.id}:${column.name}`).join("|");

  if (cachedAvrCount && cachedAvrCount.key === key && Date.now() < avrCountExpiresAt) {
    return cachedAvrCount.data;
  }
  if (pendingAvrCount && pendingAvrCountKey === key) return pendingAvrCount;

  // Столбцы обходим по одному: у YouGile нет пакетного запроса, а параллельные
  // обращения легко упираются в лимиты их API.
  const promise = (async (): Promise<AvrSitesCount> => {
    const items: AvrColumnCount[] = [];
    for (const column of columns) {
      const tasks = await fetchColumnTasks(client, column.id);
      items.push({ id: column.id, name: column.name, count: countSites(tasks) });
    }
    return {
      columns: items,
      total: items.reduce((sum, item) => sum + item.count, 0)
    };
  })();

  pendingAvrCount = promise;
  pendingAvrCountKey = key;
  try {
    const data = await promise;
    cachedAvrCount = { key, data };
    avrCountExpiresAt = Date.now() + avrCountDurationMs;
    return data;
  } finally {
    // Запрос мог быть перекрыт другим списком столбцов — чистим только свой.
    if (pendingAvrCount === promise) {
      pendingAvrCount = null;
      pendingAvrCountKey = null;
    }
  }
}

// Смена списка столбцов АВР в конфигурации: прежний подсчёт считал по старым ID.
// Вызывается из модуля portal-config сразу после сохранения нового списка.
export function invalidateAvrCountCache(): void {
  cachedAvrCount = null;
  avrCountExpiresAt = 0;
}
