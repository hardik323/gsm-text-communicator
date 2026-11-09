-- Idea and BSNL have their own formats, the other providers share the bare one.
INSERT INTO "Tsp" ("Id", "Provider", "NodalNumber", "RequestFormat", "IsActive", "CreatedDateTime", "LastStatusChangeDateTime")
VALUES
  (gen_random_uuid(), 'Idea', '078248 34221', 'CELL 91{query_number}', true, now(), now()),
  (gen_random_uuid(), 'BSNL', '094180 99998', 'Getloc 91****', true, now(), now())
ON CONFLICT ("Provider") DO UPDATE
  SET "RequestFormat" = EXCLUDED."RequestFormat",
      "LastStatusChangeDateTime" = now();
