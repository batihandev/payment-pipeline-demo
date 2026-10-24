import { handlePaymentReorg } from './payment-reorg';
import { settlePayment } from '@app/orders/settle-payment';
import { savePaymentEvent } from '@app/events/save-payment-event';
import type { Hex } from '@app/chain/chain-client';
import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '@app/db';
import { ScannerService } from './scanner.service';
@Injectable()
export class ProgressService {
  constructor(
    private readonly db: PrismaService,
    private readonly scanner: ScannerService,
    @Optional() private readonly now = () => new Date(),
  ) {}

  async advance(head: bigint, finalized = 0n): Promise<void> {
    const payments = await this.db.payment.findMany({
      where: {
        provider: 'chain',
        chainId: this.scanner.options.chainId,
        OR: [
          { final: false },
          {
            stage: { in: ['received', 'confirming'] },
            OR: [{ orderId: { not: null } }, { donation: true }],
          },
        ],
        blockNumber: { not: null },
      },
    });
    const hashes = new Map<bigint, Hex | null>();
    for (const payment of payments) {
      if (payment.blockNumber === null) continue;
      const block = payment.blockNumber;
      if (!payment.final && !hashes.has(block))
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
          current.blockNumber !== block ||
          current.blockHash !== payment.blockHash
        )
          return;
        if (!current.final && hashes.get(block) !== current.blockHash) {
          await handlePaymentReorg(tx, current, this.now());
          return;
        }
        const confirmations = Number(head > block ? head - block : 0n);
        if (
          (current.orderId || current.donation) &&
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
            current = await settlePayment(tx, current, this.now());
          }
        } else if (
          current.confirmations < this.scanner.options.confirmations &&
          current.confirmations !== confirmations
        ) {
          // Counting stops at the threshold; past it, only finality is still news.
          const updated = await tx.payment.update({
            where: { id: current.id },
            data: {
              confirmations: Math.min(
                confirmations,
                this.scanner.options.confirmations,
              ),
            },
          });
          await savePaymentEvent(tx, updated);
        }
        if (!current.final && block <= finalized) {
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
