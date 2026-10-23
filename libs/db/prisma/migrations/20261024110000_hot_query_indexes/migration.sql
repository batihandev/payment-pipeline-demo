-- CreateIndex
CREATE INDEX "incidents_kind_created_at_idx" ON "incidents"("kind", "created_at");

-- CreateIndex
CREATE INDEX "notices_delivered_at_idx" ON "notices"("delivered_at");

-- CreateIndex
CREATE INDEX "orders_status_expires_at_idx" ON "orders"("status", "expires_at");

-- CreateIndex
CREATE INDEX "orders_send_state_rail_idx" ON "orders"("send_state", "rail");

-- CreateIndex
CREATE INDEX "orders_source_created_at_idx" ON "orders"("source", "created_at");

-- CreateIndex
CREATE INDEX "payments_provider_chain_id_final_stage_idx" ON "payments"("provider", "chain_id", "final", "stage");

-- The payment feed's sort. Prisma cannot declare an expression index, so it lives here only.
CREATE INDEX "payments_feed_order_idx" ON "payments"((COALESCE("sent_at", "received_at")) DESC NULLS LAST, "id" DESC);
