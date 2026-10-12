export type ActiveWorkCheck = {
  checkId: string;
  importId: string;
  fileName: string | null;
  total: number;
  completed: number;
  startedAt: number;
};

const activeWorkChecks = new Map<string, ActiveWorkCheck>();

export function registerActiveWorkCheck(check: ActiveWorkCheck): void {
  activeWorkChecks.set(check.checkId, check);
}

export function updateActiveWorkCheck(
  checkId: string,
  patch: Partial<Pick<ActiveWorkCheck, "fileName" | "total" | "completed">>
): void {
  const check = activeWorkChecks.get(checkId);
  if (check) Object.assign(check, patch);
}

export function finishActiveWorkCheck(checkId: string): void {
  activeWorkChecks.delete(checkId);
}

export function getActiveWorkChecks(): ActiveWorkCheck[] {
  return [...activeWorkChecks.values()];
}
