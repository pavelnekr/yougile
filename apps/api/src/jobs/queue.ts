import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../config.js";

export type OperationJob = {
  operationId: string;
};

const connection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null
});

export const operationQueue = new Queue<OperationJob>("portal-operations", {
  connection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1_000 }
  }
});

export async function closeOperationQueue() {
  await operationQueue.close();
  await connection.quit();
}
