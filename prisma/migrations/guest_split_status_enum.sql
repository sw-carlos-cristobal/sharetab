-- Migration: Convert GuestSplit.status from String to GuestSplitStatus enum
-- Run this BEFORE applying the schema change via prisma db push
-- Only needed for databases with existing GuestSplit rows
-- Idempotent: safe to re-run
-- Must also be safe on an empty database: docker/entrypoint.sh runs it before
-- prisma db push on every start, including a fresh install's first one

-- Step 1: Create the enum type (skip if already exists)
DO $$ BEGIN
  CREATE TYPE "GuestSplitStatus" AS ENUM ('CLAIMING', 'FINALIZED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Step 2: Only migrate if the old text column still exists
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'GuestSplit' AND column_name = 'status'
    AND data_type = 'text'
  ) THEN
    -- Add new enum column
    ALTER TABLE "GuestSplit" ADD COLUMN "status_new" "GuestSplitStatus" DEFAULT 'FINALIZED';

    -- Migrate existing data (handle both lowercase and uppercase values)
    UPDATE "GuestSplit" SET "status_new" = CASE
      WHEN UPPER(status) = 'CLAIMING' THEN 'CLAIMING'::"GuestSplitStatus"
      WHEN UPPER(status) = 'FINALIZED' THEN 'FINALIZED'::"GuestSplitStatus"
      ELSE 'FINALIZED'::"GuestSplitStatus"
    END;

    -- Log any unexpected values before converting them
    RAISE NOTICE 'Unexpected status values (converted to FINALIZED): %',
      (SELECT string_agg(DISTINCT status, ', ') FROM "GuestSplit"
       WHERE UPPER(status) NOT IN ('CLAIMING', 'FINALIZED'));

    -- Swap columns
    ALTER TABLE "GuestSplit" DROP COLUMN "status";
    ALTER TABLE "GuestSplit" RENAME COLUMN "status_new" TO "status";
    ALTER TABLE "GuestSplit" ALTER COLUMN "status" SET NOT NULL;
    ALTER TABLE "GuestSplit" ALTER COLUMN "status" SET DEFAULT 'FINALIZED';
  END IF;
END $$;

-- Step 3: Backfill updatedAt for existing rows (required by @updatedAt)
DO $$ BEGIN
  IF to_regclass('"GuestSplit"') IS NULL THEN
    -- Fresh install: nothing to backfill; prisma db push creates the table next
    NULL;
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'GuestSplit' AND column_name = 'updatedAt'
  ) THEN
    ALTER TABLE "GuestSplit" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW();
    UPDATE "GuestSplit" SET "updatedAt" = "createdAt";
  ELSE
    UPDATE "GuestSplit" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;
  END IF;
END $$;
