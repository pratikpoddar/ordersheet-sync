-- CreateTable
CREATE TABLE "DirtyOrder" (
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "markedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    PRIMARY KEY ("shop", "orderId")
);

-- CreateTable
CREATE TABLE "PendingRedaction" (
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("shop", "orderId")
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SyncConfig" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "spreadsheetId" TEXT,
    "spreadsheetUrl" TEXT,
    "sheetGid" INTEGER,
    "sheetTitle" TEXT NOT NULL DEFAULT 'Orders',
    "columns" TEXT NOT NULL,
    "filters" TEXT NOT NULL DEFAULT '{}',
    "backfillFrom" TEXT,
    "backfillTo" TEXT,
    "layoutVersion" TEXT,
    "syncing" BOOLEAN NOT NULL DEFAULT false,
    "lockedUntil" DATETIME,
    "leaseOwner" TEXT,
    "lastSuccessAt" DATETIME,
    "lastErrorAt" DATETIME,
    "lastError" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "lastReconciledAt" DATETIME,
    "lastManualSyncAt" DATETIME,
    "jobId" TEXT,
    "jobKind" TEXT,
    "jobPhase" TEXT,
    "jobCursor" TEXT,
    "jobParams" TEXT,
    "jobForceRebuild" BOOLEAN NOT NULL DEFAULT false,
    "jobLogId" INTEGER,
    "jobStartedAt" DATETIME,
    "jobUpdatedAt" DATETIME,
    "jobPages" INTEGER NOT NULL DEFAULT 0,
    "jobRowsWritten" INTEGER NOT NULL DEFAULT 0,
    "jobAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_SyncConfig" ("backfillFrom", "backfillTo", "columns", "createdAt", "filters", "lastError", "lastErrorAt", "lastManualSyncAt", "lastReconciledAt", "lastSuccessAt", "layoutVersion", "lockedUntil", "rowCount", "sheetGid", "sheetTitle", "shop", "spreadsheetId", "spreadsheetUrl", "syncing", "updatedAt") SELECT "backfillFrom", "backfillTo", "columns", "createdAt", "filters", "lastError", "lastErrorAt", "lastManualSyncAt", "lastReconciledAt", "lastSuccessAt", "layoutVersion", "lockedUntil", "rowCount", "sheetGid", "sheetTitle", "shop", "spreadsheetId", "spreadsheetUrl", "syncing", "updatedAt" FROM "SyncConfig";
DROP TABLE "SyncConfig";
ALTER TABLE "new_SyncConfig" RENAME TO "SyncConfig";
CREATE INDEX "SyncConfig_jobId_idx" ON "SyncConfig"("jobId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "DirtyOrder_markedAt_idx" ON "DirtyOrder"("markedAt");
