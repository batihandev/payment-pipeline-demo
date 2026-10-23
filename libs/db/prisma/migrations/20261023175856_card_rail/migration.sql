-- CreateEnum
CREATE TYPE "PaymentRail" AS ENUM ('chain', 'card');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "customer_id" UUID,
ADD COLUMN     "rail" "PaymentRail" NOT NULL DEFAULT 'chain';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "receipt_url" TEXT;

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "chain_address" TEXT,
    "stripe_customer_id" TEXT,
    "stripe_payment_method_id" TEXT,
    "card_brand" TEXT,
    "card_last4" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_stripe_customer_id_key" ON "customers"("stripe_customer_id");

-- CreateIndex
CREATE INDEX "orders_customer_id_idx" ON "orders"("customer_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
