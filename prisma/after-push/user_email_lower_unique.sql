-- Enforce case-insensitive email uniqueness: "Alice@example.com" and
-- "alice@example.com" can't both belong to accounts. The @unique on
-- User.email is case-sensitive, and Prisma's schema can't express an index on
-- lower(email), so it lives here.
-- Runs after prisma db push (docker/entrypoint.sh), so "User" exists.
-- Idempotent: does nothing once the index exists.
-- Never fails startup: if the index can't be built (most likely because
-- case-variant duplicates already exist), log a warning and carry on. It's
-- retried on every start.

DO $$
DECLARE
  duplicates TEXT;
BEGIN
  IF to_regclass('"User_email_lower_key"') IS NOT NULL THEN
    RETURN;
  END IF;

  BEGIN
    CREATE UNIQUE INDEX "User_email_lower_key" ON "User" (lower(email));
  EXCEPTION
    WHEN unique_violation THEN
      SELECT string_agg(address, ', ' ORDER BY address) INTO duplicates
      FROM (
        SELECT lower(email) AS address FROM "User"
        GROUP BY lower(email)
        HAVING count(*) > 1
      ) AS dupes;
      RAISE WARNING 'Case-insensitive email uniqueness is not enforced yet: more than one account uses each of these addresses in different letter cases: %. Delete the extra accounts in the admin dashboard; ShareTab tries again on the next start.', duplicates;
    WHEN OTHERS THEN
      RAISE WARNING 'Could not create the case-insensitive email index "User_email_lower_key": % (SQLSTATE %). ShareTab tries again on the next start.', SQLERRM, SQLSTATE;
  END;
END $$;
