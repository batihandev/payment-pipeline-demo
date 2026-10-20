import { savePaymentEvent } from '../../../libs/events/src/save-payment-event';
import type { TransferLog } from '../../../libs/chain/src/chain-client';
import type { Prisma } from '../../../libs/db/src';
export async function receiveTransfer(
  tx: Prisma.TransactionClient,
  log: TransferLog,
  chainId: number,
  externalKey: string,
  now: Date,
) {
  let sent = await tx.payment.findFirst({
    where: {
      provider: 'chain',
      chainId,
      transactionHash: { equals: log.txHash, mode: 'insensitive' },
      amount: log.amount,
      stage: 'sent',
      logIndex: null,
    },
  });
  const order = sent?.orderId
    ? await tx.order.findUnique({ where: { id: sent.orderId } })
    : await tx.order.findFirst({
        where: {
          expectedAmount: log.amount,
          createdAt: { gte: new Date(now.getTime() - 86400000), lte: now },
        },
        orderBy: { createdAt: 'desc' },
      });
  if (order) {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id}::uuid FOR UPDATE`;
    sent = await tx.payment.findFirst({
      where: {
        provider: 'chain',
        chainId,
        transactionHash: { equals: log.txHash, mode: 'insensitive' },
        amount: log.amount,
        stage: 'sent',
        logIndex: null,
      },
    });
  }
  const data = {
    externalKey,
    chainId,
    transactionHash: log.txHash.toLowerCase(),
    logIndex: log.logIndex,
    amount: log.amount,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    stage: 'received' as const,
    receivedAt: now,
    orderId: order?.id ?? null,
  };
  const payment = sent
    ? await tx.payment.update({ where: { id: sent.id }, data })
    : await tx.payment.create({ data: { ...data, provider: 'chain' } });
  if (!order || order.status === 'expired' || order.expiresAt < now)
    await tx.incident.create({
      data: {
        paymentId: payment.id,
        kind: order ? 'paid_after_expiry' : 'unmatched',
        whatHappened: order
          ? 'Order paid after expiry.'
          : 'Transfer amount matched no recent order.',
        howHandled: order
          ? 'Matched the late payment and continued confirmation.'
          : 'Stored the unmatched payment without order credit.',
      },
    });
  await savePaymentEvent(tx, payment);
  return payment;
}
