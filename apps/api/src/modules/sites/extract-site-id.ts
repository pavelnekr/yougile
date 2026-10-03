export function extractSiteIdFromTaskTitle(title: unknown): string | null {
  if (typeof title !== "string") return null;
  return title.match(/^(\d+)/)?.[1] ?? null;
}
