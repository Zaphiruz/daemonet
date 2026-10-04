-- AlterTable
ALTER TABLE "Daemon" ADD COLUMN     "lockedBy" TEXT;

-- CreateTable
CREATE TABLE "ExchangeVault" (
    "operatorId" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,

    CONSTRAINT "ExchangeVault_pkey" PRIMARY KEY ("operatorId","item")
);

-- A vault row never goes negative, whichever writer (the sim's vault intent, the api's order book) gets it wrong.
ALTER TABLE "ExchangeVault" ADD CONSTRAINT "ExchangeVault_qty_check" CHECK ("qty" >= 0);
