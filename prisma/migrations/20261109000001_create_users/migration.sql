-- CreateTable
CREATE TABLE "users" (
    "Id" VARCHAR(36) NOT NULL,
    "Username" VARCHAR(64) NOT NULL,
    "PasswordHash" VARCHAR(128) NOT NULL,
    "Role" VARCHAR(20) NOT NULL DEFAULT 'viewer',
    "CreatedDateTime" TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
    "LastChangedDateTime" TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),

    CONSTRAINT "users_pkey" PRIMARY KEY ("Id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_Username_key" ON "users" ("Username");
