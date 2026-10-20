import { keccak256 } from 'viem';
import type {
  Address,
  ChainClient,
  Hex,
  TransferSigner,
} from '../../../libs/chain/src/chain-client';
import { RpcError } from '../../../libs/chain/src/rpc-error';
import {
  BudgetReservation,
  type Prisma,
  type PrismaClient,
} from '../../../libs/db/src';
import { RedisLock } from './redis-lock';

type Target = { kind: 'order' | 'sweep'; id: string };
type SenderOptions = { buyer: Address; shop: Address; chainId: number };
export class OrderSender {
  constructor(
    private readonly db: PrismaClient,
    private readonly chain: ChainClient,
    private readonly signer: TransferSigner,
    private readonly lock: RedisLock,
    private readonly options: SenderOptions,
  ) {}
  sendForOrder(orderId: string): Promise<void> {
    return this.send({ kind: 'order', id: orderId });
  }
  sendForSweep(id: string): Promise<void> {
    return this.send({ kind: 'sweep', id });
  }
  private async load(tx: Prisma.TransactionClient, target: Target) {
    if (target.kind === 'order') {
      const order = await tx.order.findUniqueOrThrow({
        where: { id: target.id },
      });
      return { ...order, amount: order.expectedAmount };
    }
    return tx.sweep.findUniqueOrThrow({ where: { id: target.id } });
  }
  private async update(
    tx: Prisma.TransactionClient,
    target: Target,
    data: Pick<
      Prisma.OrderUpdateInput,
      | 'nonce'
      | 'signedTransaction'
      | 'transactionHash'
      | 'sendAttempts'
      | 'sendState'
    >,
  ) {
    if (target.kind === 'order')
      await tx.order.update({ where: { id: target.id }, data });
    else await tx.sweep.update({ where: { id: target.id }, data });
  }
  private async prepare(target: Target, from: Address, to: Address) {
    return this.db.$transaction(
      async (tx) => {
        const address = from.toLowerCase();
        await tx.walletNonce.upsert({
          where: { address },
          create: { address, nextNonce: 0n },
          update: {},
        });
        // The database row fences nonce allocation even if the Redis lease expires.
        await tx.$queryRaw`SELECT address FROM wallet_nonces WHERE address = ${address} FOR UPDATE`;
        let row = await this.load(tx, target);
        if (row.sendState === 'failed' || row.sendState === 'sent') return row;
        if (!row.signedTransaction) {
          const allocated = await tx.walletNonce.findUniqueOrThrow({
            where: { address },
          });
          const pending = BigInt(await this.chain.getNonce(from));
          const nonce =
            pending > allocated.nextNonce ? pending : allocated.nextNonce;
          if (nonce > BigInt(Number.MAX_SAFE_INTEGER))
            throw new RpcError('permanent');
          const raw = await this.signer.signTransfer(
            from,
            to,
            row.amount,
            Number(nonce),
          );
          await this.update(tx, target, {
            nonce,
            signedTransaction: raw,
            transactionHash: keccak256(raw),
          });
          await tx.walletNonce.update({
            where: { address },
            data: { nextNonce: nonce + 1n },
          });
          row = await this.load(tx, target);
        }
        return row;
      },
      { timeout: 60000 },
    );
  }
  private async send(target: Target): Promise<void> {
    const from =
      target.kind === 'order' ? this.options.buyer : this.options.shop;
    const to = target.kind === 'order' ? this.options.shop : this.options.buyer;
    try {
      await this.lock.run(from, async () => {
        const row = await this.prepare(target, from, to);
        if (row.sendState === 'failed' || row.sendState === 'sent') return;
        if (!row.signedTransaction || !row.transactionHash)
          throw new Error('Signed transfer is missing');
        await this.update(this.db, target, { sendAttempts: { increment: 1 } });
        const hash = row.transactionHash as Hex;
        if (!(await this.chain.getTransactionReceipt(hash))) {
          const broadcast = await this.chain.sendRawTransaction(
            row.signedTransaction as Hex,
          );
          if (broadcast.toLowerCase() !== hash.toLowerCase())
            throw new RpcError('transient');
        }
        await this.db.$transaction(async (tx) => {
          await this.update(tx, target, { sendState: 'sent' });
          if (target.kind === 'order') {
            await tx.payment.upsert({
              where: {
                provider_externalKey: {
                  provider: 'chain',
                  externalKey: `sent:${row.id}`,
                },
              },
              create: {
                provider: 'chain',
                externalKey: `sent:${row.id}`,
                orderId: row.id,
                amount: row.amount,
                stage: 'sent',
                chainId: this.options.chainId,
                transactionHash: hash,
                sentAt: new Date(),
              },
              update: {},
            });
          } else {
            await tx.incident.create({
              data: {
                kind: 'swept',
                whatHappened: `Swept ${row.amount} micro-units from shop to buyer.`,
                howHandled: `Stored transfer ${hash} for sweep ${row.id}.`,
              },
            });
          }
        });
      });
    } catch (error) {
      await this.recordFailure(target, error);
      throw error instanceof RpcError ? error : new RpcError('transient');
    }
  }
  private async recordFailure(target: Target, error: unknown): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const row = await this.load(tx, target);
      const knownFailure =
        error instanceof RpcError &&
        error.kind === 'permanent' &&
        !row.signedTransaction;
      if (knownFailure && row.sendState !== 'failed') {
        await this.update(tx, target, { sendState: 'failed' });
        if (target.kind === 'order') {
          await new BudgetReservation(tx).release(row.createdAt, row.amount);
          await tx.order.update({
            where: { id: target.id },
            data: { status: 'expired' },
          });
        }
      }
      await tx.incident.create({
        data: {
          kind: 'send_failed',
          whatHappened: `Transfer ${target.id} failed (${error instanceof RpcError ? error.kind : 'transient'}).`,
          howHandled: knownFailure
            ? 'No transaction was broadcast; released the reservation and closed the order.'
            : 'Kept the reservation; retry with backoff using the same signed transaction when present.',
        },
      });
    });
  }
}
