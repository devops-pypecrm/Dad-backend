ALTER TABLE "Organisation" ADD COLUMN "incentiveConfig" JSONB;

ALTER TABLE "Commission"
ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN "calculationBase" DOUBLE PRECISION,
ADD COLUMN "calculationRate" DOUBLE PRECISION;

CREATE INDEX "Commission_organisationId_dealId_source_idx"
ON "Commission"("organisationId", "dealId", "source");

CREATE UNIQUE INDEX "Commission_one_automatic_incentive_per_deal"
ON "Commission"("organisationId", "dealId")
WHERE "source" = 'automatic' AND "dealId" IS NOT NULL AND "isDeleted" = false;
