-- The bot never sends an empty number, but the database should not accept one
-- either: NOT NULL still allows the empty string.
ALTER TABLE "locationRequests"
    ADD CONSTRAINT "locationRequests_QueryNumber_check"
    CHECK (length(btrim("QueryNumber")) > 0);
