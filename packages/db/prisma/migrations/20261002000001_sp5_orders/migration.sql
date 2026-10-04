-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'FILLED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "price" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fill" (
    "id" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "buyOrderId" TEXT NOT NULL,
    "sellOrderId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "fee" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Order_item_side_status_price_createdAt_idx" ON "Order"("item", "side", "status", "price", "createdAt");

-- CreateIndex
CREATE INDEX "Order_operatorId_status_idx" ON "Order"("operatorId", "status");

-- CreateIndex
CREATE INDEX "Order_status_expiresAt_idx" ON "Order"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Fill_item_at_idx" ON "Fill"("item", "at");

-- The engine's limits, again in the database (price 1-1048576 and qty 1-1024, so price × qty <= 2^30 fits an int4):
-- a bad writer fails loudly instead of creating or destroying escrow.
ALTER TABLE "Order" ADD CONSTRAINT "Order_limits_check"
    CHECK ("price" BETWEEN 1 AND 1048576 AND "qty" BETWEEN 1 AND 1024 AND "remaining" BETWEEN 0 AND "qty");
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_limits_check"
    CHECK ("price" BETWEEN 1 AND 1048576 AND "qty" BETWEEN 1 AND 1024 AND "fee" >= 0);
