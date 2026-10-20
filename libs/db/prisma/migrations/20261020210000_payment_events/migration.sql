CREATE TABLE "payment_events" (
    "id" BIGSERIAL NOT NULL,
    "payment_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "payment_events_published_at_id_idx" ON "payment_events"("published_at", "id");
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
