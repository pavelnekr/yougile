import { parseAssigned } from "../imports/legacy-task.js";

export type AssignmentCheck = {
  siteId: string | null;
  expectedUserId: string | null;
  assignedUserIds: unknown;
};

export type AssignmentCheckResult = {
  valid: boolean;
  reason: "ok" | "site_not_found" | "user_not_found" | "wrong_user";
};

export function checkAssignment(input: AssignmentCheck): AssignmentCheckResult {
  if (!input.siteId) return { valid: false, reason: "site_not_found" };
  if (!input.expectedUserId) return { valid: false, reason: "user_not_found" };

  const assignedUserIds = parseAssigned(input.assignedUserIds);
  return assignedUserIds.includes(input.expectedUserId)
    ? { valid: true, reason: "ok" }
    : { valid: false, reason: "wrong_user" };
}
