-- AlterTable
ALTER TABLE "SyncConfig" ADD COLUMN     "jobAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "jobCursor" TEXT,
ADD COLUMN     "jobForceRebuild" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "jobId" TEXT,
ADD COLUMN     "jobKind" TEXT,
ADD COLUMN     "jobLogId" INTEGER,
ADD COLUMN     "jobPages" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "jobParams" TEXT,
ADD COLUMN     "jobPhase" TEXT,
ADD COLUMN     "jobRowsWritten" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "jobStartedAt" TIMESTAMP(3),
ADD COLUMN     "jobUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "leaseOwner" TEXT;

-- CreateTable
CREATE TABLE "DirtyOrder" (
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "DirtyOrder_pkey" PRIMARY KEY ("shop","orderId")
);

-- CreateTable
CREATE TABLE "PendingRedaction" (
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PendingRedaction_pkey" PRIMARY KEY ("shop","orderId")
);

-- CreateIndex
CREATE INDEX "DirtyOrder_markedAt_idx" ON "DirtyOrder"("markedAt");

-- CreateIndex
CREATE INDEX "SyncConfig_jobId_idx" ON "SyncConfig"("jobId");

