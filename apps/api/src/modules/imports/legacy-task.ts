export type LegacyTask = {
  siteId: string;
  yougileTaskId: string | null;
  yougileUserId: string | null;
  address: string | null;
  cluster: string | null;
  scheduledAt: string | null;
  workRequired: string | null;
  comment: string | null;
  assignedUserIds: string[];
  rawData: Record<string, unknown>;
};

function textValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function mapLegacyTask(row: Record<string, unknown>): LegacyTask {
  const siteId = textValue(row.id_site);
  if (!siteId) throw new Error("Imported row is missing id_site");

  return {
    siteId,
    yougileTaskId: textValue(row.Id_site_youg),
    yougileUserId: textValue(row.user_Id),
    address: textValue(row.address),
    cluster: textValue(row.klaster),
    scheduledAt: textValue(row.time) ?? textValue(row.day),
    workRequired: textValue(row.What_is_required),
    comment: textValue(row.comment),
    assignedUserIds: parseAssigned(row.assigned),
    rawData: row
  };
}

export function parseAssigned(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value !== "string" || !value.trim()) return [];
  const normalized = value.trim();

  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    const parsed: unknown = JSON.parse(normalized);
    if (!Array.isArray(parsed)) throw new Error("Assigned field must contain an array");
    return parsed.filter((item): item is string => typeof item === "string");
  }

  return [normalized];
}
