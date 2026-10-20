-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('open', 'paid', 'expired');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('schedule', 'visitor');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('chain', 'stripe');

-- CreateEnum
CREATE TYPE "PaymentStage" AS ENUM ('sent', 'received', 'confirming', 'processing', 'settled', 'notified');

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "item" TEXT NOT NULL,
    "price" BIGINT NOT NULL,
    "expected_amount" BIGINT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'open',
    "source" "OrderSource" NOT NULL,
    "nonce" BIGINT,
    "signed_transaction" TEXT,
    "transaction_hash" TEXT,
    "send_attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_budgets" (
    "day" DATE NOT NULL,
    "target_count" INTEGER NOT NULL,
    "target_amount" BIGINT NOT NULL,
    "reserved_count" INTEGER NOT NULL DEFAULT 0,
    "reserved_amount" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "daily_budgets_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "scan_gaps" (
    "id" UUID NOT NULL,
    "from_block" BIGINT NOT NULL,
    "to_block" BIGINT NOT NULL,
    "error_category" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMPTZ(3) NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "scan_gaps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "external_key" TEXT NOT NULL,
    "order_id" UUID,
    "amount" BIGINT NOT NULL,
    "stage" "PaymentStage" NOT NULL DEFAULT 'received',
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "chain_id" INTEGER,
    "block_number" BIGINT,
    "block_hash" TEXT,
    "transaction_hash" TEXT,
    "log_index" INTEGER,
    "final" BOOLEAN NOT NULL DEFAULT false,
    "sent_at" TIMESTAMPTZ(3),
    "received_at" TIMESTAMPTZ(3),
    "confirming_at" TIMESTAMPTZ(3),
    "processing_at" TIMESTAMPTZ(3),
    "settled_at" TIMESTAMPTZ(3),
    "notified_at" TIMESTAMPTZ(3),
    "final_at" TIMESTAMPTZ(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "what_happened" TEXT NOT NULL,
    "how_handled" TEXT NOT NULL,
    "payment_id" UUID,
    "from_block" BIGINT,
    "to_block" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cursors" (
    "name" TEXT NOT NULL,
    "block_number" BIGINT NOT NULL,
    "block_hash" TEXT NOT NULL,

    CONSTRAINT "cursors_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "notices" (
    "payment_id" UUID NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "delivered_at" TIMESTAMPTZ(3),

    CONSTRAINT "notices_pkey" PRIMARY KEY ("payment_id")
);

-- CreateIndex
CREATE INDEX "orders_expected_amount_created_at_idx" ON "orders"("expected_amount", "created_at");

-- CreateIndex
CREATE INDEX "scan_gaps_resolved_at_next_retry_at_idx" ON "scan_gaps"("resolved_at", "next_retry_at");

-- CreateIndex
CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_external_key_key" ON "payments"("provider", "external_key");

-- CreateIndex
CREATE UNIQUE INDEX "payments_chain_id_transaction_hash_log_index_key" ON "payments"("chain_id", "transaction_hash", "log_index");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_payment_id_key" ON "ledger_entries"("payment_id");

-- CreateIndex
CREATE INDEX "incidents_payment_id_idx" ON "incidents"("payment_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notices" ADD CONSTRAINT "notices_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
