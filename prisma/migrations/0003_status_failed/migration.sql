-- Widen the status range for FAILED (8). CHECK (1..8).
ALTER TABLE "locationRequests"
    DROP CONSTRAINT IF EXISTS "locationRequests_Status_check";

ALTER TABLE "locationRequests"
    ADD CONSTRAINT "locationRequests_Status_check"
    CHECK ("Status" BETWEEN 1 AND 8);
