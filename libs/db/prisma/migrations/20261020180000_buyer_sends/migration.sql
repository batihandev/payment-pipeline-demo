ALTER TABLE "orders" ADD COLUMN "send_state" TEXT NOT NULL DEFAULT 'pending';
CREATE TABLE "wallet_nonces" (
  "address" TEXT NOT NULL PRIMARY KEY,
  "next_nonce" BIGINT NOT NULL
);
CREATE TABLE "sweeps" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "amount" BIGINT NOT NULL,
  "nonce" BIGINT,
  "signed_transaction" TEXT,
  "transaction_hash" TEXT,
  "send_attempts" INTEGER NOT NULL DEFAULT 0,
  "send_state" TEXT NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
