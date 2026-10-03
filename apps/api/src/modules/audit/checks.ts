import {
  checkAssignment,
  type AssignmentCheck
} from "../assignments/preview.js";

export type AuditedAssignment = AssignmentCheck & {
  title: string;
};

export function auditAssignments(items: AuditedAssignment[]) {
  return items.map((item) => ({
    title: item.title,
    siteId: item.siteId,
    expectedUserId: item.expectedUserId,
    ...checkAssignment(item)
  }));
}
