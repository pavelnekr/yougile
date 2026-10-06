-- AlterTable
ALTER TABLE "OperationItem" ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "OperationItem_operationId_sortOrder_idx" ON "OperationItem"("operationId", "sortOrder");
