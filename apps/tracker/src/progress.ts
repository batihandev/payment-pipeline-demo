import type { PrismaClient } from '../../../libs/db/src';
import type { TrackerOptions } from './scanner';
export class PaymentProgress {
  constructor(
    readonly db: PrismaClient,
    readonly options: TrackerOptions,
    readonly now = () => new Date(),
  ) {}
  async advance(head: bigint): Promise<void> {
    const payments = await this.db.payment.findMany({
      where: {
        provider: 'chain',
        chainId: this.options.chainId,
        orderId: { not: null },
        blockNumber: { not: null },
        stage: { in: ['received', 'confirming'] },
      },
    });
    for (const payment of payments)
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM payments WHERE id = ${payment.id}::uuid FOR UPDATE`;
        const current = await tx.payment.findUniqueOrThrow({
          where: { id: payment.id },
        });
        if (
          !current.orderId ||
          current.blockNumber === null ||
          !['received', 'confirming'].includes(current.stage)
        )
          return;
        const confirmations = Number(
          head > current.blockNumber ? head - current.blockNumber : 0n,
        );
        if (current.stage === 'received')
          await tx.payment.update({
            where: { id: current.id },
            data: {
              stage: 'confirming',
              confirmingAt: this.now(),
              confirmations,
            },
          });
        else
          await tx.payment.update({
            where: { id: current.id },
            data: { confirmations },
          });
        if (confirmations < this.options.confirmations) return;
        await tx.ledgerEntry.create({
          data: { paymentId: current.id, amount: current.amount },
        });
        await tx.payment.update({
          where: { id: current.id },
          data: { stage: 'settled', settledAt: this.now() },
        });
        await tx.order.update({
          where: { id: current.orderId },
          data: { status: 'paid' },
        });
      });
  }
}
