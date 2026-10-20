import { savePaymentEvent } from './payment-events';
import type { Hex } from '../../../libs/chain/src/chain-client';
import type { PrismaClient } from '../../../libs/db/src';
import type { Scanner } from './scanner';
export class PaymentProgress {
  constructor(
    readonly db: PrismaClient,
    readonly scanner: Scanner,
    readonly now = () => new Date(),
  ) {}
  async advance(head: bigint, finalized = 0n): Promise<void> {
    const payments = await this.db.payment.findMany({
      where: {
        provider: 'chain',
        chainId: this.scanner.options.chainId,
        final: false,
        blockNumber: { not: null },
      },
    });
    const hashes = new Map<bigint, Hex | null>();
    for (const payment of payments) {
      if (payment.blockNumber === null) continue;
      const block = payment.blockNumber;
      if (!hashes.has(block))
        hashes.set(
          block,
          await this.scanner.rpc(() => this.scanner.chain.getBlockHash(block)),
        );
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM payments WHERE id = ${payment.id}::uuid FOR UPDATE`;
        let current = await tx.payment.findUniqueOrThrow({
          where: { id: payment.id },
        });
        if (
          current.final ||
          current.blockNumber !== block ||
          current.blockHash !== payment.blockHash
        )
          return;
        const credited =
          current.stage === 'settled' || current.stage === 'notified';
        if (hashes.get(block) !== current.blockHash) {
          const kind = credited ? 'settled_reorg' : 'payment_reorg';
          if (
            !(await tx.incident.findFirst({
              where: { kind, paymentId: current.id, fromBlock: block },
            }))
          )
            await tx.incident.create({
              data: {
                kind,
                paymentId: current.id,
                fromBlock: block,
                toBlock: block,
                whatHappened: 'The payment block is no longer canonical.',
                howHandled: credited
                  ? 'Kept the ledger credit for manual review; withheld finality.'
                  : 'Dropped the payment back to sent and scheduled a rescan.',
              },
            });
          if (!credited) {
            const dropped = await tx.payment.update({
              where: { id: current.id },
              data: {
                stage: 'sent',
                blockNumber: null,
                blockHash: null,
                confirmations: 0,
                receivedAt: null,
                confirmingAt: null,
              },
            });
            await savePaymentEvent(tx, dropped);
            await tx.scanGap.create({
              data: {
                fromBlock: block,
                toBlock: block,
                errorCategory: 'reorg',
                nextRetryAt: this.now(),
              },
            });
          }
          return;
        }
        const confirmations = Number(head > block ? head - block : 0n);
        if (
          current.orderId &&
          ['received', 'confirming'].includes(current.stage)
        ) {
          const changed =
            current.stage !== 'confirming' ||
            current.confirmations !== confirmations;
          current = await tx.payment.update({
            where: { id: current.id },
            data: {
              stage: 'confirming',
              confirmingAt: current.confirmingAt ?? this.now(),
              confirmations,
            },
          });
          if (changed) await savePaymentEvent(tx, current);
          if (confirmations >= this.scanner.options.confirmations) {
            await tx.ledgerEntry.create({
              data: { paymentId: current.id, amount: current.amount },
            });
            current = await tx.payment.update({
              where: { id: current.id },
              data: { stage: 'settled', settledAt: this.now() },
            });
            await savePaymentEvent(tx, current);
            await tx.notice.upsert({
              where: { paymentId: current.id },
              create: { paymentId: current.id },
              update: {},
            });
            await tx.order.update({
              where: { id: current.orderId ?? '' },
              data: { status: 'paid' },
            });
          }
        } else
          await tx.payment.update({
            where: { id: current.id },
            data: { confirmations },
          });
        if (block <= finalized) {
          const finalPayment = await tx.payment.update({
            where: { id: current.id },
            data: { final: true, finalAt: this.now() },
          });
          await savePaymentEvent(tx, finalPayment);
        }
      });
    }
  }
}
