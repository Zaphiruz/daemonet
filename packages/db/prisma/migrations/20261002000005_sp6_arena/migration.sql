-- CreateTable
CREATE TABLE "ArenaSeason" (
    "id" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "ArenaSeason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArenaRating" (
    "operatorId" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "rating" DOUBLE PRECISION NOT NULL,
    "rd" DOUBLE PRECISION NOT NULL,
    "vol" DOUBLE PRECISION NOT NULL,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ArenaRating_pkey" PRIMARY KEY ("operatorId","seasonId")
);

-- CreateTable
CREATE TABLE "ArenaMatch" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "aId" TEXT NOT NULL,
    "bId" TEXT NOT NULL,
    "winnerId" TEXT,
    "reason" TEXT NOT NULL,
    "aBefore" DOUBLE PRECISION NOT NULL,
    "aAfter" DOUBLE PRECISION NOT NULL,
    "bBefore" DOUBLE PRECISION NOT NULL,
    "bAfter" DOUBLE PRECISION NOT NULL,
    "aReward" INTEGER NOT NULL DEFAULT 0,
    "bReward" INTEGER NOT NULL DEFAULT 0,
    "aWins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bWins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "counted" BOOLEAN NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArenaMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArenaRating_seasonId_rating_idx" ON "ArenaRating"("seasonId", "rating");

-- CreateIndex
CREATE INDEX "ArenaMatch_aId_endedAt_idx" ON "ArenaMatch"("aId", "endedAt");

-- CreateIndex
CREATE INDEX "ArenaMatch_bId_endedAt_idx" ON "ArenaMatch"("bId", "endedAt");

-- CreateIndex
CREATE INDEX "ArenaMatch_endedAt_idx" ON "ArenaMatch"("endedAt");
