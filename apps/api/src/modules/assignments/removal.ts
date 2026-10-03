import { ImportRowStatus, OperationItemStatus, OperationStatus, OperationType, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { YougileClient } from "../../integrations/yougile/client.js";
import type { OperationJob } from "../../jobs/queue.js";
import { getPlannedSites } from "../sites/service.js";
import { getAssignmentUsers } from "../users/service.js";
import { AssignmentValidationError, maxSitesPerOperation, readTask, tooManySitesError, validatePlanTask } from "./service.js";

export const importRemovalSchema = z.object({
  rowNumbers: z.array(z.number().int().positive()).min(1).max(maxSitesPerOperation, tooManySitesError("строк XLSX"))
    .refine((rows) => new Set(rows).size === rows.length, "В плане выбраны повторяющиеся строки.")
});

export type ImportRemovalInput = z.infer<typeof importRemovalSchema>;

function normalizeEngineerName(name: string) {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
}

export async function prepareImportRemoval(
  client: YougileClient,
  prisma: PrismaClient,
  importId: string,
  rowNumbers: number[]
) {
  const batch = await prisma.importBatch.findUnique({
    where: { id: importId },
    include: {
      rows: {
        where: { rowNumber: { in: rowNumbers } },
        orderBy: { rowNumber: "asc" }
      }
    }
  });
  if (!batch) throw new AssignmentValidationError("Загрузка XLSX не найдена. Выберите файл из аудита или загрузите его ещё раз.");
  if (batch.rows.length !== rowNumbers.length) {
    throw new AssignmentValidationError("Часть строк не относится к выбранному файлу XLSX.");
  }

  const [employees, plannedSites] = await Promise.all([
    getAssignmentUsers(client),
    getPlannedSites(client)
  ]);
  const usersById = new Map(employees.map((user) => [user.id, user]));
  const taskById = new Map(plannedSites.map((site) => [site.taskId, site]));
  const siteIds = new Set<string>();
  const items = [];

  for (const row of batch.rows) {
    if (
      row.status !== ImportRowStatus.READY ||
      !row.siteId ||
      !row.engineerName ||
      !row.engineerUserId ||
      !row.yougileTaskId
    ) {
      throw new AssignmentValidationError(`Строка ${row.rowNumber}: площадка или инженер не сопоставлены с YouGile.`);
    }
    if (siteIds.has(row.siteId)) {
      throw new AssignmentValidationError(`Площадка ${row.siteId} указана в XLSX более одного раза.`);
    }
    siteIds.add(row.siteId);

    const user = usersById.get(row.engineerUserId);
    if (!user || normalizeEngineerName(user.name) !== normalizeEngineerName(row.engineerName)) {
      throw new AssignmentValidationError(`Инженер из строки ${row.rowNumber} больше не найден в YouGile. Загрузите XLSX ещё раз.`);
    }

    const plannedSite = taskById.get(row.yougileTaskId);
    if (!plannedSite || plannedSite.siteNumber !== row.siteId) {
      throw new AssignmentValidationError(`Строка ${row.rowNumber}: площадка больше не находится в активном плане YouGile.`);
    }
    const task = await readTask(client, row.yougileTaskId);
    const currentSite = validatePlanTask(task, taskById);
    if (currentSite.siteNumber !== row.siteId) {
      throw new AssignmentValidationError(`Строка ${row.rowNumber}: площадка изменилась после загрузки XLSX.`);
    }

    const assignedUserIds = task.assigned ?? [];
    items.push({
      rowNumber: row.rowNumber,
      importRowId: row.id,
      siteId: row.siteId,
      address: row.address,
      taskId: row.yougileTaskId,
      title: task.title,
      engineerName: user.name,
      userId: user.id,
      assignedUserIds,
      willRemove: assignedUserIds.includes(user.id),
      assignedEngineerNames: assignedUserIds.map((id) =>
        employees.find((employee) => employee.id === id)?.name ?? "Сотрудник не найден"
      ),
      remainingEngineerNames: assignedUserIds
        .filter((id) => id !== user.id)
        .map((id) => employees.find((employee) => employee.id === id)?.name ?? "Сотрудник не найден")
    });
  }

  return { batchId: batch.id, fileName: batch.fileName, items };
}

export async function processRemovalOperation(
  prisma: PrismaClient,
  client: YougileClient,
  { operationId }: OperationJob
) {
  const operation = await prisma.operation.findUnique({
    where: { id: operationId },
    include: { items: { orderBy: { createdAt: "asc" } } }
  });
  if (!operation || operation.type !== OperationType.REMOVE) {
    throw new Error(`Removal operation ${operationId} was not found`);
  }
  if (operation.status === OperationStatus.SUCCEEDED || operation.status === OperationStatus.PARTIAL) return;

  await prisma.operation.update({
    where: { id: operationId },
    data: { status: OperationStatus.RUNNING, startedAt: new Date() }
  });

  const siteByTaskId = new Map((await getPlannedSites(client)).map((site) => [site.taskId, site]));
  let cursor = 0;
  const workerCount = Math.min(3, operation.items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < operation.items.length) {
      const item = operation.items[cursor++];
      if (item.status === OperationItemStatus.SUCCEEDED || item.status === OperationItemStatus.SKIPPED) continue;

      const taskIdValue = item.beforeData && typeof item.beforeData === "object" &&
        !Array.isArray(item.beforeData) && "taskId" in item.beforeData
        ? item.beforeData.taskId
        : null;
      const userId = item.requestedUserId;
      let status: OperationItemStatus = OperationItemStatus.FAILED;
      let beforeData: object | undefined;
      let afterData: object | undefined;
      let errorMessage: string | undefined;

      try {
        if (typeof taskIdValue !== "string" || !userId) {
          throw new Error("В операции отсутствуют данные задачи или инженера.");
        }

        const task = await readTask(client, taskIdValue);
        const plannedSite = validatePlanTask(task, siteByTaskId);
        if (plannedSite.siteNumber !== item.siteId) {
          throw new Error("Номер площадки изменился после предпросмотра.");
        }

        const assigned = task.assigned ?? [];
        beforeData = { taskId: task.id, title: task.title, assignedUserIds: assigned, removedUserId: userId };
        const nextAssigned = assigned.filter((assignedUserId) => assignedUserId !== userId);
        if (nextAssigned.length === assigned.length) {
          status = OperationItemStatus.SKIPPED;
          afterData = { taskId: task.id, title: task.title, assignedUserIds: assigned, removed: false };
        } else {
          await client.request(`tasks/${encodeURIComponent(task.id)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ assigned: nextAssigned })
          });
          status = OperationItemStatus.SUCCEEDED;
          afterData = { taskId: task.id, title: task.title, assignedUserIds: nextAssigned, removed: true };
        }
      } catch (error) {
        status = OperationItemStatus.FAILED;
        errorMessage = error instanceof Error
          ? `Не удалось снять инженера с площадки ${item.siteId}: ${error.message}`
          : `Не удалось снять инженера с площадки ${item.siteId}.`;
        console.error("Removal item failed", {
          operationId,
          siteId: item.siteId,
          error: error instanceof Error ? error.message : "Unknown error"
        });
      }

      await prisma.operationItem.update({
        where: { id: item.id },
        data: {
          status,
          attempts: { increment: 1 },
          beforeData,
          afterData,
          errorMessage,
          completedAt: new Date()
        }
      });

      await prisma.operation.update({
        where: { id: operationId },
        data: {
          completed: { increment: 1 },
          ...(status === OperationItemStatus.FAILED ? { failed: { increment: 1 } } : {}),
          message: "Снятие инженеров выполняется."
        }
      });
    }
  }));

  const results = await prisma.operationItem.findMany({ where: { operationId } });
  const failed = results.filter((item) => item.status === OperationItemStatus.FAILED).length;
  const completed = results.filter((item) =>
    item.status === OperationItemStatus.SUCCEEDED ||
    item.status === OperationItemStatus.SKIPPED ||
    item.status === OperationItemStatus.FAILED
  ).length;
  const status = failed === 0
    ? OperationStatus.SUCCEEDED
    : failed === completed
      ? OperationStatus.FAILED
      : OperationStatus.PARTIAL;

  await prisma.operation.update({
    where: { id: operationId },
    data: {
      status,
      completed,
      failed,
      message: failed === 0
        ? "Снятие инженеров по XLSX завершено."
        : `Не удалось снять инженеров с площадок: ${failed} из ${operation.total}.`,
      finishedAt: new Date()
    }
  });
}
