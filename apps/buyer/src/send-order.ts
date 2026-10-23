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

class NonceResynced extends RpcError {
  constructor() {
    super('transient');
  }
}
type Target = { kind: 'order' | 'sweep'; id: string };
const UNSEEN_AFTER_MS = 2 * 60 * 1000;
type SenderOptions = { buyer: Address; shop: Address; chainId: number };
export class OrderSender {
  constructor(
    private readonly db: PrismaClient,
    private readonly chain: ChainClient,
    private readonly signer: TransferSigner,
    private readonly lock: RedisLock,
    private readonly options: SenderOptions,
  ) {}
  private readonly suspectedDropped = new Set<string>();
  /** Buyer-wallet transfers broadcast but not yet seen by the tracker. */
  inFlight(): Promise<number> {
    return this.db.order.count({
      where: {
        sendState: 'sent',
        payments: { some: { stage: 'sent' } },
      },
    });
  }
  /**
   * Closes or rebroadcasts buyer transfers the tracker has not seen two minutes after sending.
   * A transfer that reverted, or whose nonce another transaction used, can never pay its order,
   * so the order is closed and leaves the in-flight count. A revert is read from a receipt and
   * closes at once. A dropped transfer has no receipt and a used nonce, and a lagging RPC backend
   * can report both for a transfer that landed, so it closes only when two consecutive runs find
   * it dropped; a receipt, an unused nonce, or leaving the unseen list in between clears the suspicion. The suspicion is
   * kept in memory, so a restart delays a close by one run. Otherwise the stored transfer is
   * broadcast again, which is idempotent.
   */
  async checkUnseen(now = new Date()): Promise<void> {
    const orders = await this.db.order.findMany({
      where: {
        sendState: 'sent',
        payments: {
          some: {
            stage: 'sent',
            sentAt: { lt: new Date(now.getTime() - UNSEEN_AFTER_MS) },
          },
        },
      },
      orderBy: { nonce: 'asc' },
    });
    const listed = new Set(orders.map((order) => order.id));
    for (const id of this.suspectedDropped)
      if (!listed.has(id)) this.suspectedDropped.delete(id);
    if (!orders.length) return;
    // Read before the receipts, as in broadcast(), to narrow the lagging-node window.
    const confirmed = BigInt(
      await this.chain.getConfirmedNonce(this.options.buyer),
    );
    for (const order of orders) {
      if (!order.transactionHash || !order.signedTransaction) continue;
      const receipt = await this.chain.getTransactionReceipt(
        order.transactionHash as Hex,
      );
      const dropped =
        !receipt && order.nonce !== null && confirmed > order.nonce;
      if (!dropped) this.suspectedDropped.delete(order.id);
      if (receipt?.status === 'reverted')
        await this.closeUnseen(order.id, {
          kind: 'send_reverted',
          whatHappened: 'Transfer reverted on chain.',
        });
      else if (receipt) continue;
      else if (dropped) {
        if (this.suspectedDropped.delete(order.id))
          await this.closeUnseen(order.id, {
            kind: 'send_dropped',
            whatHappened:
              'Another transfer used this nonce, so it can never land.',
          });
        else this.suspectedDropped.add(order.id);
      } else
        await this.chain.sendRawTransaction(order.signedTransaction as Hex);
    }
  }
  private async closeUnseen(
    orderId: string,
    incident: { kind: string; whatHappened: string },
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await this.lockRow(tx, { kind: 'order', id: orderId });
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { payments: true },
      });
      const payment = order.payments.find((p) => p.stage === 'sent');
      // The tracker may have seen the transfer since the check began.
      if (order.sendState !== 'sent' || !payment) return;
      await tx.order.update({
        where: { id: orderId },
        data: { sendState: 'failed', status: 'expired' },
      });
      if (order.source === 'schedule')
        await new BudgetReservation(tx).release(
          order.createdAt,
          order.expectedAmount,
        );
      await tx.incident.create({
        data: {
          ...incident,
          paymentId: payment.id,
          howHandled: 'Closed the order; nothing was credited.',
        },
      });
    });
  }
  sendForOrder(orderId: string, exhausted = false): Promise<void> {
    return this.send({ kind: 'order', id: orderId }, exhausted);
  }
  sendForSweep(id: string, exhausted = false): Promise<void> {
    return this.send({ kind: 'sweep', id }, exhausted);
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
  private async lockRow(
    tx: Prisma.TransactionClient,
    target: Target,
  ): Promise<void> {
    if (target.kind === 'order')
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${target.id}::uuid FOR UPDATE`;
    else
      await tx.$queryRaw`SELECT id FROM sweeps WHERE id = ${target.id} FOR UPDATE`;
  }
  private async prepare(target: Target, from: Address, to: Address) {
    return this.db.$transaction(
      async (tx) => {
        const address = from.toLowerCase();
        const created = await tx.$executeRaw`
          INSERT INTO wallet_nonces (address, next_nonce) VALUES (${address}, 0)
          ON CONFLICT (address) DO NOTHING
        `;
        // The database row fences nonce allocation even if the Redis lease expires.
        await tx.$queryRaw`SELECT address FROM wallet_nonces WHERE address = ${address} FOR UPDATE`;
        await this.lockRow(tx, target);
        let row = await this.load(tx, target);
        if (
          target.kind === 'order' &&
          'status' in row &&
          row.status === 'expired' &&
          !row.signedTransaction &&
          row.sendState === 'pending'
        ) {
          await this.update(tx, target, { sendState: 'failed' });
          if ('source' in row && row.source === 'schedule')
            await new BudgetReservation(tx).release(row.createdAt, row.amount);
          return this.load(tx, target);
        }
        if (row.sendState === 'failed' || row.sendState === 'sent') return row;
        if (!row.signedTransaction) {
          const allocated = await tx.walletNonce.findUniqueOrThrow({
            where: { address },
          });
          // The chain is asked only to seed a wallet that has no nonce row yet.
          const nonce =
            created > 0
              ? BigInt(await this.chain.getNonce(from))
              : allocated.nextNonce;
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
  private async send(target: Target, exhausted: boolean): Promise<void> {
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
        // Only a retry can already have landed.
        const landed =
          row.sendAttempts > 0 &&
          (await this.chain.getTransactionReceipt(hash));
        if (!landed) {
          const broadcast = await this.broadcast(target, from, row, hash);
          if (broadcast.toLowerCase() !== hash.toLowerCase())
            throw new RpcError('transient');
        }
        await this.db.$transaction(async (tx) => {
          await this.lockRow(tx, target);
          if ((await this.load(tx, target)).sendState === 'sent') return;
          await this.update(tx, target, { sendState: 'sent' });
          if (target.kind === 'order') {
            const observed = await tx.payment.findFirst({
              where: {
                provider: 'chain',
                chainId: this.options.chainId,
                transactionHash: { equals: hash, mode: 'insensitive' },
              },
            });
            if (observed) {
              await tx.payment.update({
                where: { id: observed.id },
                data: {
                  sentAt: observed.sentAt ?? new Date(),
                  orderId: row.id,
                },
              });
              return;
            }
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
            const refill = row.id.startsWith('refill:');
            await tx.incident.create({
              data: refill
                ? {
                    kind: 'refilled',
                    whatHappened: `Refilled the buyer with ${row.amount} micro-units from the shop.`,
                    howHandled: `Stored transfer ${hash} for refill ${row.id}.`,
                  }
                : {
                    kind: 'swept',
                    whatHappened: `Swept ${row.amount} micro-units from shop to buyer.`,
                    howHandled: `Stored transfer ${hash} for sweep ${row.id}.`,
                  },
            });
          }
        });
      });
    } catch (error) {
      // A resync already recorded its own incident; the transfer was replaced, not kept.
      if (!(error instanceof NonceResynced))
        await this.recordFailure(target, error, exhausted);
      throw error instanceof RpcError ? error : new RpcError('transient');
    }
  }
  // A "nonce too low" answer means another transaction used this nonce. The stored transfer is
  // dropped only when it has no receipt and the chain's mined nonce is past it, so it can never
  // land and the order never has two transfers that can.
  private async broadcast(
    target: Target,
    from: Address,
    row: { signedTransaction: string | null; nonce: bigint | null },
    hash: Hex,
  ): Promise<Hex> {
    try {
      return await this.chain.sendRawTransaction(row.signedTransaction as Hex);
    } catch (error) {
      if (!(error instanceof RpcError) || error.kind !== 'nonce_too_low')
        throw error;
      // The mined nonce is read before the receipt, so a node that reports the nonce as used
      // has usually mined the transfer too. This narrows the window in which a lagging node
      // answers "no receipt" for a mined transfer, but cannot rule it out when requests reach
      // different load-balanced backends.
      if (
        row.nonce === null ||
        BigInt(await this.chain.getConfirmedNonce(from)) <= row.nonce
      )
        throw error;
      if (await this.chain.getTransactionReceipt(hash)) return hash;
      const pending = BigInt(await this.chain.getNonce(from));
      const address = from.toLowerCase();
      const reset = await this.db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT address FROM wallet_nonces WHERE address = ${address} FOR UPDATE`;
          await this.lockRow(tx, target);
          if ((await this.load(tx, target)).transactionHash !== hash)
            return false;
          const allocated = await tx.walletNonce.findUniqueOrThrow({
            where: { address },
          });
          await tx.walletNonce.update({
            where: { address },
            data: {
              nextNonce:
                pending > allocated.nextNonce ? pending : allocated.nextNonce,
            },
          });
          await this.update(tx, target, {
            nonce: null,
            signedTransaction: null,
            transactionHash: null,
          });
          await tx.incident.create({
            data: {
              kind: 'nonce_resynced',
              whatHappened: 'Nonce was behind the chain.',
              howHandled:
                'Moved the nonce forward and signed the transfer again.',
            },
          });
          return true;
        },
        { timeout: 60000 },
      );
      if (reset) throw new NonceResynced();
      throw new RpcError('transient');
    }
  }
  private async recordFailure(
    target: Target,
    error: unknown,
    exhausted: boolean,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await this.lockRow(tx, target);
      const row = await this.load(tx, target);
      const knownFailure =
        error instanceof RpcError &&
        error.kind === 'permanent' &&
        !row.signedTransaction;
      if (knownFailure && row.sendState !== 'failed') {
        await this.update(tx, target, { sendState: 'failed' });
        if (target.kind === 'order') {
          // Only a scheduled order took a reservation; visitor orders never touch the budget.
          if ('source' in row && row.source === 'schedule')
            await new BudgetReservation(tx).release(row.createdAt, row.amount);
          await tx.order.update({
            where: { id: target.id },
            data: { status: 'expired' },
          });
        }
      }
      const needsReview =
        exhausted || (error instanceof RpcError && error.kind === 'permanent');
      if (needsReview && !knownFailure && row.sendState === 'pending')
        await this.update(tx, target, { sendState: 'review' });
      await tx.incident.create({
        data: {
          kind: 'send_failed',
          whatHappened: `Transfer ${target.id} failed (${error instanceof RpcError ? error.kind : 'transient'}).`,
          howHandled: knownFailure
            ? 'No transaction was broadcast; released the reservation and closed the order.'
            : needsReview
              ? 'Automatic retries stopped; kept the reservation and the same signed transaction for manual review.'
              : 'Kept the reservation; retry with backoff using the same signed transaction when present.',
        },
      });
    });
  }
}
