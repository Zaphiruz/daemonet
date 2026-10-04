-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'DONE', 'ABANDONED');

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "subnet" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "target" INTEGER NOT NULL,
    "reward" INTEGER NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Research" (
    "operatorId" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Research_pkey" PRIMARY KEY ("operatorId","line")
);

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_operatorId_day_subnet_index_key" ON "Ticket"("operatorId", "day", "subnet", "index");

-- CreateIndex
CREATE INDEX "Ticket_operatorId_status_idx" ON "Ticket"("operatorId", "status");

-- CreateIndex
CREATE INDEX "Ticket_operatorId_day_idx" ON "Ticket"("operatorId", "day");
