export type OperationKind = "assign" | "remove" | "reassign" | "audit";

export type OperationStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled";

export type OperationProgress = {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  total: number;
  completed: number;
  failed: number;
  message: string | null;
};

export type AssignmentPreviewItem = {
  siteId: string;
  address: string | null;
  expectedUserId: string | null;
  expectedUserName: string | null;
  currentUserIds: string[];
  valid: boolean;
  issue: "site_not_found" | "user_not_found" | "wrong_user" | null;
};
