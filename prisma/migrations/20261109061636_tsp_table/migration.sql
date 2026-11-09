-- CreateTable
CREATE TABLE "Tsp" (
    "Id" UUID NOT NULL,
    "Provider" VARCHAR(50) NOT NULL,
    "NodalNumber" VARCHAR(32) NOT NULL,
    "RequestFormat" VARCHAR(64) NOT NULL DEFAULT '91{query_number}',
    "IsActive" BOOLEAN NOT NULL DEFAULT true,
    "CreatedDateTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "LastStatusChangeDateTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tsp_pkey" PRIMARY KEY ("Id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tsp_Provider_key" ON "Tsp"("Provider");

-- CreateIndex
CREATE INDEX "Tsp_IsActive_idx" ON "Tsp"("IsActive");
