export type OperationHistoryFilter = {
  type?: "ASSIGN" | "REMOVE" | "REASSIGN" | "AUDIT" | "USER_SYNC" | "IMPORT";
  status?: "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "CANCELLED";
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
};
