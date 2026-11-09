-- One open request per (user, chat, number). If the same number is asked while
-- the previous request is still in progress, the bot says so instead of
-- queueing a second one.

-- Existing duplicates: keep the newest open row for each key, remove the
-- older ones (they are the same request, asked twice).
WITH ranked AS (
  SELECT "Id", ROW_NUMBER() OVER (
    PARTITION BY "UserId", "ChatId", "QueryNumber"
    ORDER BY "CreatedDateTime" DESC, "Id" DESC
  ) AS rn
  FROM "locationRequests"
  WHERE "Status" IN (1, 2, 5)
)
DELETE FROM "locationRequests" r
USING ranked
WHERE r."Id" = ranked."Id" AND ranked.rn > 1;

-- Partial unique index: two rows with the same (user, chat, number) may only
-- exist once the earlier one has left an open status (3, 4, 6, 7 or 8).
CREATE UNIQUE INDEX "locationRequests_one_open_request"
  ON "locationRequests" ("UserId", "ChatId", "QueryNumber")
  WHERE "Status" IN (1, 2, 5);
