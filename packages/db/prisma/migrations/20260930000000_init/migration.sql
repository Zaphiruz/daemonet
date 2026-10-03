-- CreateEnum
CREATE TYPE "Location" AS ENUM ('RAM', 'DISK');

-- CreateTable
CREATE TABLE "Operator" (
    "id" TEXT NOT NULL,
    "sub" TEXT NOT NULL,
    "name" TEXT,
    "starterClaimed" BOOLEAN NOT NULL DEFAULT false,
    "bits" BIGINT NOT NULL DEFAULT 0,
    "subnet" TEXT NOT NULL DEFAULT 'lo',
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "inventory" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Daemon" (
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
    "hp" INTEGER NOT NULL,
    "energy" INTEGER NOT NULL,
    "moves" TEXT[],
    "crashed" BOOLEAN NOT NULL,
    "location" "Location" NOT NULL,
    "slot" INTEGER NOT NULL,
    "originalOperatorId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "captureSubnet" TEXT NOT NULL,
    "captureTool" TEXT NOT NULL,
    "spawnSeedId" TEXT NOT NULL,
    "spawnIndex" INTEGER,

    CONSTRAINT "Daemon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubnetSeed" (
    "id" TEXT NOT NULL,
    "subnet" TEXT NOT NULL,
    "seed" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubnetSeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppliedAction" (
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppliedAction_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Operator_sub_key" ON "Operator"("sub");

-- CreateIndex
CREATE UNIQUE INDEX "Operator_name_key" ON "Operator"("name");

-- CreateIndex
CREATE INDEX "Daemon_operatorId_idx" ON "Daemon"("operatorId");

-- CreateIndex
CREATE UNIQUE INDEX "Daemon_operatorId_location_slot_key" ON "Daemon"("operatorId", "location", "slot");

-- AddForeignKey
ALTER TABLE "Daemon" ADD CONSTRAINT "Daemon_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
