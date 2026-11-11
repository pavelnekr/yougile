import type { Prisma, PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import { decryptYougileToken, decryptPortalColumnId, encryptPortalColumnId } from "../../integrations/yougile/token-crypto.js";
import { YougileClient } from "../../integrations/yougile/client.js";
import { isYougileBusy } from "../../lib/yougile-activity.js";
import { getPlanColumn, loadAvrColumns } from "../portal-config/service.js";
import { getAvrSites, getPlannedSites, type AvrSitesList, type PlannedSite } from "./service.js";

const planSnapshotKey = "sites:plan-snapshot";
const avrSnapshotKey = "sites:avr-snapshot";
export const siteSnapshotAdminKey = "sites:snapshot-admin-id";
const refreshIntervalMs = 2 * 60_000;
const refreshFailureCooldownMs = 60_000;

const siteSchema = z.object({
  taskId: z.string(),
  siteNumber: z.string(),
  title: z.string(),
  assignedCount: z.number(),
  completed: z.boolean(),
  updatedAt: z.string().nullable()
});
const planSnapshotSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  columnSignature: z.string(),
  sourceAdminId: z.string(),
  items: z.array(siteSchema)
});
const avrDataSchema = z.object({
  columns: z.array(z.object({ id: z.string(), name: z.string(), sites: z.array(siteSchema) })),
  items: z.array(siteSchema),
  total: z.number(),
  engineerAssignments: z.array(z.object({ name: z.string(), siteCount: z.number() })).default([])
});
const avrSnapshotSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  columnsSignature: z.string(),
  sourceAdminId: z.string(),
  data: avrDataSchema
});

type StoredPlanSnapshot = z.infer<typeof planSnapshotSchema>;
type StoredAvrSnapshot = z.infer<typeof avrSnapshotSchema>;

let refreshPromise: Promise<void> | null = null;
let lastRefreshFailedAt = 0;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let stopRequested = false;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function planColumnSignature(): string {
  return hash(getPlanColumn().id);
}

function avrColumnsSignature(columns: { id: string; name: string }[]): string {
  return hash(columns.map(({ id, name }) => [id, name]));
}

function decodeAvrSnapshot(snapshot: StoredAvrSnapshot): StoredAvrSnapshot {
  return {
    ...snapshot,
    data: {
      ...snapshot.data,
      columns: snapshot.data.columns.map((column) => ({
        ...column,
        id: column.id.startsWith("v1:") ? decryptPortalColumnId(column.id, "avr") : column.id
      }))
    }
  };
}

function encodeAvrSnapshot(snapshot: StoredAvrSnapshot): StoredAvrSnapshot {
  return {
    ...snapshot,
    data: {
      ...snapshot.data,
      columns: snapshot.data.columns.map((column) => ({
        ...column,
        id: encryptPortalColumnId(column.id, "avr")
      }))
    }
  };
}

async function findSnapshotAdmin(prisma: PrismaClient) {
  const [ownerSetting, legacyOwnerSetting] = await Promise.all([
    prisma.appSetting.findUnique({ where: { key: siteSnapshotAdminKey } }),
    prisma.appSetting.findUnique({ where: { key: "sites:avr-snapshot-admin-id" } })
  ]);
  const ownerId = typeof ownerSetting?.value === "string"
    ? ownerSetting.value
    : typeof legacyOwnerSetting?.value === "string" ? legacyOwnerSetting.value : null;
  const where = {
    role: "ADMIN" as const,
    active: true,
    yougileTokenEncrypted: { not: null }
  };

  if (ownerId) {
    const owner = await prisma.portalUser.findFirst({
      where: { ...where, id: ownerId },
      select: { id: true, yougileTokenEncrypted: true }
    });
    if (owner?.yougileTokenEncrypted) return owner;
  }

  return prisma.portalUser.findFirst({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, yougileTokenEncrypted: true }
  });
}

async function savePlanSnapshot(prisma: PrismaClient, items: PlannedSite[], sourceAdminId: string): Promise<void> {
  const snapshot: StoredPlanSnapshot = {
    version: 1,
    updatedAt: new Date().toISOString(),
    columnSignature: planColumnSignature(),
    sourceAdminId,
    items
  };
  await prisma.appSetting.upsert({
    where: { key: planSnapshotKey },
    create: { key: planSnapshotKey, value: snapshot as unknown as Prisma.InputJsonValue },
    update: { value: snapshot as unknown as Prisma.InputJsonValue }
  });
}

async function saveAvrSnapshot(prisma: PrismaClient, data: AvrSitesList, columns: { id: string; name: string }[], sourceAdminId: string): Promise<void> {
  const snapshot: StoredAvrSnapshot = {
    version: 1,
    updatedAt: new Date().toISOString(),
    columnsSignature: avrColumnsSignature(columns),
    sourceAdminId,
    data
  };
  const encrypted = encodeAvrSnapshot(snapshot);
  await prisma.appSetting.upsert({
    where: { key: avrSnapshotKey },
    create: { key: avrSnapshotKey, value: encrypted as unknown as Prisma.InputJsonValue },
    update: { value: encrypted as unknown as Prisma.InputJsonValue }
  });
}

async function performRefresh(prisma: PrismaClient): Promise<void> {
  const [columns, admin] = await Promise.all([loadAvrColumns(prisma), findSnapshotAdmin(prisma)]);
  if (await isYougileBusy(prisma)) return;
  if (!admin?.yougileTokenEncrypted) {
    throw new Error("Нет активного администратора с настроенным токеном YouGile для снимков площадок.");
  }

  const client = new YougileClient(decryptYougileToken(admin.yougileTokenEncrypted, admin.id));
  const plannedSites = await getPlannedSites(client, { forceRefresh: true });
  await savePlanSnapshot(prisma, plannedSites, admin.id);

  const avrData: AvrSitesList = columns.length
    ? await getAvrSites(client, columns, { forceRefresh: true })
    : { columns: [], items: [], total: 0, engineerAssignments: [] };
  await saveAvrSnapshot(prisma, avrData, columns, admin.id);
}

export function refreshSiteSnapshots(prisma: PrismaClient): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = performRefresh(prisma)
    .then(() => { lastRefreshFailedAt = 0; }, (error: unknown) => {
      lastRefreshFailedAt = Date.now();
      throw error;
    })
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function readPlanSnapshot(prisma: PrismaClient): Promise<StoredPlanSnapshot | null> {
  const setting = await prisma.appSetting.findUnique({ where: { key: planSnapshotKey } });
  const parsed = planSnapshotSchema.safeParse(setting?.value);
  return parsed.success ? parsed.data : null;
}

async function readAvrSnapshot(prisma: PrismaClient): Promise<StoredAvrSnapshot | null> {
  const setting = await prisma.appSetting.findUnique({ where: { key: avrSnapshotKey } });
  const parsed = avrSnapshotSchema.safeParse(setting?.value);
  return parsed.success ? decodeAvrSnapshot(parsed.data) : null;
}

function refreshIsAllowed(): boolean {
  return Date.now() - lastRefreshFailedAt >= refreshFailureCooldownMs;
}

export async function getPlanSitesSnapshot(
  prisma: PrismaClient,
  options: { requireCurrentConfig?: boolean } = {}
): Promise<{ items: PlannedSite[]; updatedAt: string; refreshing: boolean }> {
  let snapshot = await readPlanSnapshot(prisma);
  if (!snapshot && await isYougileBusy(prisma)) {
    return { items: [], updatedAt: new Date().toISOString(), refreshing: true };
  }
  const current = snapshot?.columnSignature === planColumnSignature();
  const expired = !snapshot || Date.now() - Date.parse(snapshot.updatedAt) >= refreshIntervalMs;
  if (!current || expired) {
    if (!refreshPromise && refreshIsAllowed()) void refreshSiteSnapshots(prisma).catch(() => undefined);
    if (!snapshot) {
      if (!refreshPromise && !refreshIsAllowed()) throw new Error("Общий снимок плана пока недоступен.");
      await refreshSiteSnapshots(prisma);
      snapshot = await readPlanSnapshot(prisma);
    }
  }
  if (options.requireCurrentConfig && snapshot?.columnSignature !== planColumnSignature()) {
    if (refreshPromise) await refreshSiteSnapshots(prisma);
    snapshot = await readPlanSnapshot(prisma);
    if (snapshot?.columnSignature !== planColumnSignature()) {
      throw new Error("Снимок плана обновляется после изменения конфигурации. Повторите запрос позже.");
    }
  }
  if (!snapshot) throw new Error("Общий снимок плана ещё не сформирован.");
  return { items: snapshot.items, updatedAt: snapshot.updatedAt, refreshing: Boolean(refreshPromise) };
}

export async function getAvrSitesSnapshot(
  prisma: PrismaClient,
  columns: { id: string; name: string }[],
  options: { requireCurrentConfig?: boolean } = {}
): Promise<{ data: AvrSitesList; updatedAt: string; refreshing: boolean }> {
  let snapshot = await readAvrSnapshot(prisma);
  if (!snapshot && await isYougileBusy(prisma)) {
    return {
      data: { columns: columns.map((column) => ({ ...column, sites: [] })), items: [], total: 0, engineerAssignments: [] },
      updatedAt: new Date().toISOString(),
      refreshing: true
    };
  }
  const current = snapshot?.columnsSignature === avrColumnsSignature(columns);
  const expired = !snapshot || Date.now() - Date.parse(snapshot.updatedAt) >= refreshIntervalMs;
  if (!current || expired) {
    if (!refreshPromise && refreshIsAllowed()) void refreshSiteSnapshots(prisma).catch(() => undefined);
    if (!snapshot) {
      if (!refreshPromise && !refreshIsAllowed()) throw new Error("Общий снимок АВР пока недоступен.");
      await refreshSiteSnapshots(prisma);
      snapshot = await readAvrSnapshot(prisma);
    }
  }
  if (options.requireCurrentConfig && snapshot?.columnsSignature !== avrColumnsSignature(columns)) {
    if (refreshPromise) await refreshSiteSnapshots(prisma);
    snapshot = await readAvrSnapshot(prisma);
    if (snapshot?.columnsSignature !== avrColumnsSignature(columns)) {
      throw new Error("Снимок АВР обновляется после изменения конфигурации. Повторите запрос позже.");
    }
  }
  if (!snapshot) throw new Error("Общий снимок АВР ещё не сформирован.");
  return { data: snapshot.data, updatedAt: snapshot.updatedAt, refreshing: Boolean(refreshPromise) };
}

export function startSiteSnapshotRefresh(prisma: PrismaClient, onError: (error: unknown) => void): () => void {
  stopRequested = false;
  const refresh = async () => {
    try {
      await refreshSiteSnapshots(prisma);
    } catch (error) {
      onError(error);
    } finally {
      if (!stopRequested) refreshTimer = setTimeout(refresh, refreshIntervalMs);
    }
  };
  void refresh();
  return () => {
    stopRequested = true;
    if (refreshTimer) clearTimeout(refreshTimer);
  };
}
