-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "donation" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "from_address" TEXT;
