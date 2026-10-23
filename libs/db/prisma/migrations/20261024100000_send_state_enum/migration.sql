-- CreateEnum
CREATE TYPE "SendState" AS ENUM ('pending', 'sent', 'failed', 'review');

-- Convert in place, so existing rows keep their state. A value outside the enum fails the cast.
ALTER TABLE "orders"
  ALTER COLUMN "send_state" DROP DEFAULT,
  ALTER COLUMN "send_state" TYPE "SendState" USING "send_state"::"SendState",
  ALTER COLUMN "send_state" SET DEFAULT 'pending';

ALTER TABLE "sweeps"
  ALTER COLUMN "send_state" DROP DEFAULT,
  ALTER COLUMN "send_state" TYPE "SendState" USING "send_state"::"SendState",
  ALTER COLUMN "send_state" SET DEFAULT 'pending';
