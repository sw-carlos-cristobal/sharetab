-- Migration: Convert GuestSplit.status from String to GuestSplitStatus enum
-- Run this BEFORE applying the schema change via prisma db push
-- Only needed for databases with existing GuestSplit rows

-- Step 1: Create the enum type
DO $$ BEGIN
  CREATE TYPE "GuestSplitStatus" AS ENUM ('CLAIMING', 'FINALIZED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Step 2: Add new enum column
ALTER TABLE "GuestSplit" ADD COLUMN IF NOT EXISTS "status_new" "GuestSplitStatus" DEFAULT 'FINALIZED';

-- Step 3: Migrate existing data
UPDATE "GuestSplit" SET "status_new" = CASE
  WHEN status = 'claiming' THEN 'CLAIMING'::"GuestSplitStatus"
  ELSE 'FINALIZED'::"GuestSplitStatus"
END;

-- Step 4: Swap columns
ALTER TABLE "GuestSplit" DROP COLUMN "status";
ALTER TABLE "GuestSplit" RENAME COLUMN "status_new" TO "status";
ALTER TABLE "GuestSplit" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "GuestSplit" ALTER COLUMN "status" SET DEFAULT 'FINALIZED';
