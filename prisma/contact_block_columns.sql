-- Additive, nullable/defaulted - safe to run before deploying the new backend.
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "phoneKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "isBlocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "blockedAt" TIMESTAMP(3);
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "blockedById" TEXT;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "blockedReason" TEXT;
CREATE INDEX IF NOT EXISTS "Contact_organisationId_isBlocked_idx" ON "Contact"("organisationId","isBlocked");
-- Backfill phone keys for existing contacts (last 10 digits of each saved number).
UPDATE "Contact" c SET "phoneKeys" = COALESCE((
  SELECT array_agg(DISTINCT right(regexp_replace(p->>'number','\D','','g'),10))
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.phones::jsonb)='array' THEN c.phones::jsonb ELSE '[]'::jsonb END) p
  WHERE length(regexp_replace(coalesce(p->>'number',''),'\D','','g')) >= 6
), ARRAY[]::TEXT[])
WHERE c.phones IS NOT NULL;
