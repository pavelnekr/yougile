export type ActiveWorkCheck = {
  checkId: string;
  importId: string;
  fileName: string | null;
  total: number;
  completed: number;
  startedAt: number;
  stopRequested?: boolean;
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

export function requestStopActiveWorkCheck(checkId: string): boolean {
  const check = activeWorkChecks.get(checkId);
  if (!check) return false;
  check.stopRequested = true;
  return true;
}

export function isActiveWorkCheckStopRequested(checkId: string): boolean {
  return activeWorkChecks.get(checkId)?.stopRequested === true;
}

export function getActiveWorkChecks(): ActiveWorkCheck[] {
  return [...activeWorkChecks.values()];
}
