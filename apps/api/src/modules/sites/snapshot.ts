import type { Prisma, PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import { decryptYougileToken } from "../../integrations/yougile/token-crypto.js";
import { decryptPortalColumnId, encryptPortalColumnId } from "../../integrations/yougile/token-crypto.js";
import { YougileClient } from "../../integrations/yougile/client.js";
import { loadAvrColumns } from "../portal-config/service.js";
import { isYougileBusy } from "../../lib/yougile-activity.js";
import { getAvrSites, type AvrSitesList } from "./service.js";

const snapshotKey = "sites:avr-snapshot";
export const avrSnapshotAdminKey = "sites:avr-snapshot-admin-id";
const refreshIntervalMs = 5 * 60_000;
const refreshFailureCooldownMs = 60_000;

const siteSchema = z.object({
  taskId: z.string(),
  siteNumber: z.string(),
  title: z.string(),
  assignedCount: z.number(),
  completed: z.boolean(),
  updatedAt: z.string().nullable()
});
const snapshotDataSchema = z.object({
  columns: z.array(z.object({ id: z.string(), name: z.string(), sites: z.array(siteSchema) })),
  items: z.array(siteSchema),
  total: z.number()
});
const storedSnapshotSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  columnsSignature: z.string(),
  sourceAdminId: z.string(),
  data: snapshotDataSchema
});

type StoredSnapshot = z.infer<typeof storedSnapshotSchema>;

let refreshPromise: Promise<StoredSnapshot> | null = null;
let lastRefreshFailedAt = 0;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let stopRequested = false;

function signature(columns: { id: string; name: string }[]): string {
  return createHash("sha256").update(JSON.stringify(columns.map(({ id, name }) => [id, name]))).digest("hex");
}

function decodeSnapshot(snapshot: StoredSnapshot): StoredSnapshot {
  return {
    ...snapshot,
    data: {
      ...snapshot.data,
      columns: snapshot.data.columns.map((column) => ({
        ...column,
        id: decryptPortalColumnId(column.id, "avr")
      }))
    }
  };
}

function encodeSnapshot(snapshot: StoredSnapshot): StoredSnapshot {
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

async function saveSnapshot(prisma: PrismaClient, snapshot: StoredSnapshot): Promise<void> {
  const encrypted = encodeSnapshot(snapshot);
  await prisma.appSetting.upsert({
    where: { key: snapshotKey },
    create: { key: snapshotKey, value: encrypted as unknown as Prisma.InputJsonValue },
    update: { value: encrypted as unknown as Prisma.InputJsonValue }
  });
}

async function findSnapshotAdmin(prisma: PrismaClient) {
  const ownerSetting = await prisma.appSetting.findUnique({ where: { key: avrSnapshotAdminKey } });
  const ownerId = typeof ownerSetting?.value === "string" ? ownerSetting.value : null;
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

async function performRefresh(prisma: PrismaClient): Promise<StoredSnapshot> {
  const [columns, admin] = await Promise.all([
    loadAvrColumns(prisma),
    findSnapshotAdmin(prisma)
  ]);
  if (await isYougileBusy(prisma)) {
    const existing = await prisma.appSetting.findUnique({ where: { key: snapshotKey } });
    const parsed = storedSnapshotSchema.safeParse(existing?.value);
    if (parsed.success) return decodeSnapshot(parsed.data);
    throw new Error("Обновление снимка АВР отложено: выполняется операция в YouGile.");
  }

  if (columns.length === 0) {
    const data: AvrSitesList = { columns: [], items: [], total: 0 };
    const snapshot: StoredSnapshot = {
      version: 1,
      updatedAt: new Date().toISOString(),
      columnsSignature: signature(columns),
      sourceAdminId: admin?.id ?? "none",
      data
    };
    await saveSnapshot(prisma, snapshot);
    return snapshot;
  }

  if (!admin?.yougileTokenEncrypted) {
    throw new Error("Нет активного администратора с настроенным токеном YouGile для снимка АВР.");
  }

  const token = decryptYougileToken(admin.yougileTokenEncrypted, admin.id);
  const client = new YougileClient(token);
  const data: AvrSitesList = await getAvrSites(client, columns, { forceRefresh: true });
  const snapshot: StoredSnapshot = {
    version: 1,
    updatedAt: new Date().toISOString(),
    columnsSignature: signature(columns),
    sourceAdminId: admin.id,
    data
  };

  await saveSnapshot(prisma, snapshot);
  return snapshot;
}

export function refreshAvrSitesSnapshot(prisma: PrismaClient): Promise<StoredSnapshot> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = performRefresh(prisma)
    .then((snapshot) => {
      lastRefreshFailedAt = 0;
      return snapshot;
    }, (error: unknown) => {
      lastRefreshFailedAt = Date.now();
      throw error;
    })
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export async function getAvrSitesSnapshot(
  prisma: PrismaClient,
  columns: { id: string; name: string }[]
): Promise<{ data: AvrSitesList; updatedAt: string; refreshing: boolean }> {
  const setting = await prisma.appSetting.findUnique({ where: { key: snapshotKey } });
  const parsed = storedSnapshotSchema.safeParse(setting?.value);
  const snapshot = parsed.success ? decodeSnapshot(parsed.data) : null;
  const isCurrentConfig = snapshot?.columnsSignature === signature(columns);
  const isExpired = !snapshot || Date.now() - Date.parse(snapshot.updatedAt) >= refreshIntervalMs;

  if (!snapshot || !isCurrentConfig || isExpired) {
    const outsideFailureCooldown = Date.now() - lastRefreshFailedAt >= refreshFailureCooldownMs;
    if (!refreshPromise && outsideFailureCooldown) {
      void refreshAvrSitesSnapshot(prisma).catch(() => undefined);
    }
    if (!snapshot) {
      if (!refreshPromise && !outsideFailureCooldown) {
        throw new Error("Общий снимок АВР пока недоступен; сервер повторит обновление позднее.");
      }
      const firstSnapshot = await refreshAvrSitesSnapshot(prisma);
      return { data: firstSnapshot.data, updatedAt: firstSnapshot.updatedAt, refreshing: false };
    }
    return { data: snapshot.data, updatedAt: snapshot.updatedAt, refreshing: Boolean(refreshPromise) };
  }

  return { data: snapshot.data, updatedAt: snapshot.updatedAt, refreshing: Boolean(refreshPromise) };
}

export function startAvrSitesSnapshotRefresh(
  prisma: PrismaClient,
  onError: (error: unknown) => void
): () => void {
  stopRequested = false;
  const refresh = async () => {
    try {
      await refreshAvrSitesSnapshot(prisma);
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
