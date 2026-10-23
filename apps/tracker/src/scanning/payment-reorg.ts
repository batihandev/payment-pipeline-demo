import type { Payment } from '../../../../libs/db/generated/client';
import type { Prisma } from '../../../../libs/db/src';
import { savePaymentEvent } from '../../../../libs/events/src/save-payment-event';
import { recordIncident } from '../../../../libs/db/src';
export async function handlePaymentReorg(
  tx: Prisma.TransactionClient,
  observed: Payment,
  now: Date,
): Promise<boolean> {
  await tx.$queryRaw`SELECT id FROM payments WHERE id = ${observed.id}::uuid FOR UPDATE`;
  const payment = await tx.payment.findUniqueOrThrow({
    where: { id: observed.id },
  });
  if (
    payment.blockNumber === null ||
    payment.blockNumber !== observed.blockNumber ||
    payment.blockHash !== observed.blockHash
  )
    return false;
  const block = payment.blockNumber;
  const credited = payment.stage === 'settled' || payment.stage === 'notified';
  const kind = credited ? 'settled_reorg' : 'payment_reorg';
  if (
    !(await tx.incident.findFirst({
      where: { kind, paymentId: payment.id, fromBlock: block },
    }))
  )
    await recordIncident(tx, {
      kind,
      paymentId: payment.id,
      fromBlock: block,
      toBlock: block,
      whatHappened: 'The payment block is no longer canonical.',
      howHandled: credited
        ? 'Kept the ledger credit for manual review; withheld finality.'
        : 'Dropped the payment back to sent and scheduled a rescan.',
    });
  if (credited) return true;
  const dropped = await tx.payment.update({
    where: { id: payment.id },
    data: {
      stage: 'sent',
      blockNumber: null,
      blockHash: null,
      logIndex: null,
      confirmations: 0,
      receivedAt: null,
      confirmingAt: null,
      final: false,
      finalAt: null,
    },
  });
  await savePaymentEvent(tx, dropped);
  await tx.scanGap.create({
    data: {
      fromBlock: block,
      toBlock: block,
      errorCategory: 'reorg',
      nextRetryAt: now,
    },
  });
  return false;
}
