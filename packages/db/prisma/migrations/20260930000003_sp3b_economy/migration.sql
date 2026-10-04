-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "diskCapacity" INTEGER NOT NULL DEFAULT 256;

-- CreateTable
CREATE TABLE "BitsLedger" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "operatorId" TEXT NOT NULL,
    "delta" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "ref" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BitsLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DaemonArchive" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "species" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "xp" INTEGER NOT NULL,
    "nature" INTEGER NOT NULL,
    "traitSlot" INTEGER NOT NULL,
    "ivs" INTEGER[],
    "bonus" INTEGER[],
    "clean" BOOLEAN NOT NULL,
    "signature" INTEGER NOT NULL,
    "moves" TEXT[],
    "heldItem" TEXT,
    "patched" BOOLEAN NOT NULL,
    "moveTypeUses" INTEGER[],
    "crashes" INTEGER NOT NULL,
    "arenaWins" INTEGER NOT NULL,
    "history" JSONB NOT NULL,
    "originalOperatorId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "captureSubnet" TEXT NOT NULL,
    "captureTool" TEXT NOT NULL,
    "spawnSeedId" TEXT NOT NULL,
    "spawnIndex" INTEGER,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,

    CONSTRAINT "DaemonArchive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BitsLedger_operatorId_at_idx" ON "BitsLedger"("operatorId", "at");

-- CreateIndex
CREATE INDEX "BitsLedger_at_idx" ON "BitsLedger"("at");

-- CreateIndex
CREATE INDEX "DaemonArchive_operatorId_idx" ON "DaemonArchive"("operatorId");
