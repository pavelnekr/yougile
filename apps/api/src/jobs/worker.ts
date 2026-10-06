import { Worker } from "bullmq";
import { PrismaClient, type LogLevel, type OperationType } from "@prisma/client";
import { Redis } from "ioredis";
import { config } from "../config.js";
import { getUserYougileClient } from "../integrations/yougile/user-client.js";
import { processAssignmentOperation } from "../modules/assignments/service.js";
import { processRemovalOperation } from "../modules/assignments/removal.js";
import { processCommentOperation } from "../modules/comments/service.js";
import { recordLog } from "../modules/logs/service.js";
import type { OperationJob } from "./queue.js";

// Названия операций для журнала. Три типа — это и есть все, кто попадает в
// очередь; остальные значения enum существуют для будущих сценариев и в
// журнал приходят как есть, без выдуманного перевода.
const operationTypeLabels: Partial<Record<OperationType, string>> = {
  ASSIGN: "Назначение инженера",
  REMOVE: "Снятие инженеров",
  COMMENT: "Отправка комментариев"
};

function operationLabel(type: OperationType | null | undefined) {
  if (type && operationTypeLabels[type]) return operationTypeLabels[type];
  return type ?? "Операция";
}

const completionPhrases: Partial<Record<string, string>> = {
  SUCCEEDED: "Операция выполнена",
  PARTIAL: "Операция завершена частично",
  FAILED: "Операция завершена с ошибкой",
  CANCELLED: "Операция отменена"
};

/**
 * Строки журнала о работе очереди.
 *
 * Воркер живёт вне HTTP-потока: оператор к этому моменту уже получил
 * «202 Accepted», и в интерфейсе он видит только опрос статуса операции. Если же
 * фоновая часть упала, в HTTP-журнале остался бы один успешный POST, а причина —
 * в консоли контейнера, куда администратор портала не заглядывает.
 */
async function logOperationStart(
  prisma: PrismaClient,
  operationId: string,
  type: OperationType | null | undefined,
  total: number,
  actor: { login: string; role: string } | null
) {
  await recordLog(prisma, {
    level: "INFO",
    action: `Фоновая операция: ${operationLabel(type)}`,
    message: `Операция взята в работу: площадок ${total}`,
    actorLogin: actor?.login ?? null,
    actorRole: actor?.role ?? null,
    entityId: operationId
  });
}

async function logOperationFinish(prisma: PrismaClient, operationId: string, failure?: Error) {
  try {
    const operation = await prisma.operation.findUnique({
      where: { id: operationId },
      select: {
        type: true,
        status: true,
        total: true,
        completed: true,
        failed: true,
        createdBy: { select: { login: true, role: true } }
      }
    });
    if (!operation) return;

    const base = {
      action: `Фоновая операция: ${operationLabel(operation.type)}`,
      actorLogin: operation.createdBy?.login ?? null,
      actorRole: operation.createdBy?.role ?? null,
      entityId: operationId
    };
    const counts = `площадок ${operation.total}, обработано ${operation.completed}, ошибок ${operation.failed}`;

    if (failure) {
      await recordLog(prisma, {
        ...base,
        level: "ERROR",
        message: `Операция не выполнена: ${failure.message}`,
        error: (failure.stack ?? `${failure.name}: ${failure.message}`).slice(0, 2000)
      });
      return;
    }

    // Статус PARTIAL — это тоже результат, который оператор обязан увидеть:
    // часть площадок не обработана, но в HTTP-ответе этого не было.
    const level: LogLevel = operation.status === "FAILED"
      ? "ERROR"
      : operation.status === "PARTIAL"
        ? "WARN"
        : "INFO";
    const phrase = completionPhrases[operation.status] ?? `Операция в статусе ${operation.status}`;

    await recordLog(prisma, { ...base, level, message: `${phrase}: ${counts}` });
  } catch (error) {
    console.error("Could not write operation outcome to portal log", {
      operationId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export function createOperationWorker(prisma: PrismaClient) {
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const worker = new Worker<OperationJob>(
    "portal-operations",
    async (job) => {
      try {
        const operation = await prisma.operation.findUnique({
          where: { id: job.data.operationId },
          select: {
            id: true,
            type: true,
            total: true,
            createdById: true,
            createdBy: { select: { login: true, role: true } }
          }
        });
        void logOperationStart(
          prisma,
          job.data.operationId,
          operation?.type,
          operation?.total ?? 0,
          operation?.createdBy ?? null
        );
        const yougile = await getUserYougileClient(prisma, operation?.createdById ?? undefined, {
          retryOnRateLimit: operation?.type === "ASSIGN" || operation?.type === "REMOVE"
        });
        if (job.name === "remove-engineers") {
          await processRemovalOperation(prisma, yougile, job.data);
        } else if (job.name === "post-comments") {
          await processCommentOperation(prisma, yougile, job.data);
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

  worker.on("completed", (job) => {
    void logOperationFinish(prisma, job.data.operationId);
  });

  worker.on("failed", (job, error) => {
    console.error("Operation worker failed", {
      operationId: job?.data.operationId,
      error: error.message
    });
    if (job) void logOperationFinish(prisma, job.data.operationId, error);
  });

  worker.on("error", (error) => {
    console.error("Operation queue connection failed", { error: error.message });
  });

  return worker;
}
