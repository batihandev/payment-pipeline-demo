-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "reconciled_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "reconciled_at" TIMESTAMPTZ(3);
