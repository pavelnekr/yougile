import { Worker } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { config } from "../config.js";
import { YougileClient } from "../integrations/yougile/client.js";
import { processAssignmentOperation } from "../modules/assignments/service.js";
import { processRemovalOperation } from "../modules/assignments/removal.js";
import type { OperationJob } from "./queue.js";

export function createOperationWorker(prisma: PrismaClient, yougile: YougileClient) {
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const worker = new Worker<OperationJob>(
    "portal-operations",
    async (job) => {
      try {
        if (job.name === "remove-engineers") {
          await processRemovalOperation(prisma, yougile, job.data);
        } else {
          await processAssignmentOperation(prisma, yougile, job.data);
        }
      } catch (error) {
        const failedOperation = await prisma.operation.update({
          where: { id: job.data.operationId },
          data: {
            status: "FAILED",
            message: "Не удалось запустить операцию.",
            finishedAt: new Date()
          },
          select: { metadata: true }
        }).catch((databaseError: unknown) => {
          console.error("Could not mark assignment operation as failed", {
            operationId: job.data.operationId,
            error: databaseError instanceof Error ? databaseError.message : "Unknown database error"
          });
          return null;
        });
        const metadata = failedOperation?.metadata;
        if (metadata && typeof metadata === "object" && "importBatchId" in metadata && typeof metadata.importBatchId === "string") {
          await prisma.importBatch.updateMany({
            where: { id: metadata.importBatchId },
            data: { status: "COMPLETE" }
          });
        }
        throw error;
      }
    },
    { connection, concurrency: 1 }
  );

  worker.on("failed", (job, error) => {
    console.error("Operation worker failed", {
      operationId: job?.data.operationId,
      error: error.message
    });
  });

  worker.on("error", (error) => {
    console.error("Operation queue connection failed", { error: error.message });
  });

  return worker;
}
