-- CreateEnum
CREATE TYPE "IncidentOutcome" AS ENUM ('OPEN', 'CLEARED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "n" INTEGER NOT NULL,
    "species" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "outcome" "IncidentOutcome" NOT NULL DEFAULT 'OPEN',
    "participants" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Incident_openedAt_idx" ON "Incident"("openedAt");
