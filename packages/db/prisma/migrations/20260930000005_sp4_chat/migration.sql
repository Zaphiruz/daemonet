-- CreateEnum
CREATE TYPE "FilterKind" AS ENUM ('WORD', 'REGEX');

-- CreateEnum
CREATE TYPE "FilterAction" AS ENUM ('BLOCK', 'MASK');

-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('SPAM', 'HARASSMENT', 'CHEATING', 'NAME', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'ACTIONED', 'DISMISSED');

-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "mutedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "toId" TEXT,
    "text" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatBlock" (
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatBlock_pkey" PRIMARY KEY ("blockerId","blockedId")
);

-- CreateTable
CREATE TABLE "ChatFilterTerm" (
    "id" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "kind" "FilterKind" NOT NULL,
    "action" "FilterAction" NOT NULL,
    "addedBy" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatFilterTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatFilterHit" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatFilterHit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "messageId" TEXT,
    "reason" "ReportReason" NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "action" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatMessage_channel_at_idx" ON "ChatMessage"("channel", "at");

-- CreateIndex
CREATE INDEX "ChatMessage_operatorId_at_idx" ON "ChatMessage"("operatorId", "at");

-- CreateIndex
CREATE INDEX "ChatFilterHit_operatorId_at_idx" ON "ChatFilterHit"("operatorId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "Report_reporterId_messageId_key" ON "Report"("reporterId", "messageId");

-- CreateIndex
CREATE INDEX "Report_status_at_idx" ON "Report"("status", "at");

-- CreateIndex
CREATE INDEX "Report_reporterId_at_idx" ON "Report"("reporterId", "at");
