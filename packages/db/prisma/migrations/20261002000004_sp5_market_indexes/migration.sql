-- Admin market view (24 h windows): sales by soldAt, fills by time across items.

-- CreateIndex
CREATE INDEX "Listing_status_soldAt_idx" ON "Listing"("status", "soldAt");

-- CreateIndex
CREATE INDEX "Fill_at_idx" ON "Fill"("at");
