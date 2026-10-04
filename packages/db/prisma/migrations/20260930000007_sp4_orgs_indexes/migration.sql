-- CreateIndex
CREATE INDEX "BitsLedger_operatorId_seq_idx" ON "BitsLedger"("operatorId", "seq");

-- CreateIndex
CREATE INDEX "Daemon_originalOperatorId_idx" ON "Daemon"("originalOperatorId");

-- CreateIndex
CREATE INDEX "DaemonArchive_originalOperatorId_idx" ON "DaemonArchive"("originalOperatorId");
