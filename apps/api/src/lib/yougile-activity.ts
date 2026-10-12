import { OperationStatus, type PrismaClient } from "@prisma/client";

// Признак того, что портал прямо сейчас нагружает YouGile долгой операцией.
//
// Назначение, снятие и отправка комментариев — фоновая запись в YouGile с
// паузой 4 секунды между площадками; «Проверка работ» — длинное синхронное
// чтение чатов задач в том же темпе. Если в этот момент портал ещё и перечитывает
// списки площадок («Площадки в фильтрации», «Площадки в АВР»), YouGile получает
// параллельные запросы и отвечает HTTP 429 «Too Many Requests». Поэтому, пока
// операция идёт, списки площадок не перечитываются: отдаётся последний кэш,
// а свежие данные подтягиваются, когда операции закончились.
//
// Операции очереди живут в БД (Operation в статусе QUEUED/RUNNING), поэтому их
// занятость читается запросом к базе. Проверка работ в очередь не попадает —
// это синхронный запрос, — поэтому её занятость отмечается счётчиком в процессе:
// несколько одновременных проверок складываются, и каждая снимает свою метку.
let workCheckRuns = 0;

export function beginWorkCheck(): void {
  workCheckRuns += 1;
}

export function endWorkCheck(): void {
  workCheckRuns = Math.max(0, workCheckRuns - 1);
}

export async function isYougileBusy(prisma: PrismaClient): Promise<boolean> {
  if (workCheckRuns > 0) return true;

  const activeOperations = await prisma.operation.count({
    where: { status: { in: [OperationStatus.QUEUED, OperationStatus.RUNNING] } }
  });

  return activeOperations > 0;
}
