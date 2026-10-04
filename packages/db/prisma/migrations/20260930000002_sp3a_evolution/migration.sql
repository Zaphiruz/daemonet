-- AlterTable
ALTER TABLE "Daemon" ADD COLUMN     "arenaWins" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "crashes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "heldItem" TEXT,
ADD COLUMN     "history" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "moveTypeUses" INTEGER[],
ADD COLUMN     "patched" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Discovery" (
    "formId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Discovery_pkey" PRIMARY KEY ("formId")
);
