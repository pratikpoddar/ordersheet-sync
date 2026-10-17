-- CreateTable
CREATE TABLE "Shop" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "plan" TEXT NOT NULL DEFAULT 'FREE',
    "planCheckedAt" DATETIME,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GoogleConnection" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT,
    "encryptedRefreshToken" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "connectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SyncConfig" (
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
    "lastSuccessAt" DATETIME,
    "lastErrorAt" DATETIME,
    "lastError" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "lastReconciledAt" DATETIME,
    "lastManualSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "rowsWritten" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT
);

-- CreateIndex
CREATE INDEX "SyncLog_shop_startedAt_idx" ON "SyncLog"("shop", "startedAt");
