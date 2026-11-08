-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "locationRequests" (
    "Id" UUID NOT NULL,
    "UserId" BIGINT NOT NULL,
    "ChatId" BIGINT NOT NULL,
    "QueryNumber" VARCHAR(16) NOT NULL,
    "TSP" VARCHAR(100),
    "NodalResponse" TEXT,
    "Status" INTEGER NOT NULL DEFAULT 1,
    "CreatedDateTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "LastStatusChangeDateTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locationRequests_pkey" PRIMARY KEY ("Id")
);

-- CreateIndex
CREATE INDEX "locationRequests_ChatId_CreatedDateTime_idx" ON "locationRequests"("ChatId", "CreatedDateTime");

-- CreateIndex
CREATE INDEX "locationRequests_UserId_CreatedDateTime_idx" ON "locationRequests"("UserId", "CreatedDateTime");

-- CreateIndex
CREATE INDEX "locationRequests_QueryNumber_idx" ON "locationRequests"("QueryNumber");

-- CreateIndex
CREATE INDEX "locationRequests_Status_CreatedDateTime_idx" ON "locationRequests"("Status", "CreatedDateTime");

-- Prisma cannot express CHECK constraints, so the status codes are enforced here.
-- 1=created 2=TspRequested 3=TspFound 4=TspNotFound 5=locationRequested
-- 6=NodalResponseFound 7=NodalResponseTimeout
ALTER TABLE "locationRequests"
    ADD CONSTRAINT "locationRequests_Status_check" CHECK ("Status" BETWEEN 1 AND 7);
