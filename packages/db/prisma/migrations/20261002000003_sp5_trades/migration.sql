-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "aId" TEXT NOT NULL,
    "bId" TEXT NOT NULL,
    "status" "TradeStatus" NOT NULL DEFAULT 'OPEN',
    "aOffer" JSONB NOT NULL,
    "bOffer" JSONB NOT NULL,
    "aConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "bConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Trade_aId_status_idx" ON "Trade"("aId", "status");

-- CreateIndex
CREATE INDEX "Trade_bId_status_idx" ON "Trade"("bId", "status");

-- CreateIndex
CREATE INDEX "Trade_status_updatedAt_idx" ON "Trade"("status", "updatedAt");
