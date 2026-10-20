import { setTimeout } from 'node:timers/promises';
import type {
  ChainClient,
  TransferLog,
} from '../../../libs/chain/src/chain-client';
import { RpcError } from '../../../libs/chain/src/rpc-error';
import type { Prisma, PrismaClient } from '../../../libs/db/src';
export type TrackerOptions = {
  chainId: number;
  shop: string;
  maxRange: number;
  minRange: number;
  rescanBlocks: number;
  rpcAttempts: number;
  gapAttempts: number;
  confirmations: number;
};
export type TrackerChain = Pick<
  ChainClient,
  'getHead' | 'getFinalized' | 'getBlockHash' | 'getTransferLogs'
>;
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
export class Scanner {
  readonly cursorName: string;
  constructor(
    readonly db: PrismaClient,
    readonly chain: TrackerChain,
    readonly options: TrackerOptions,
    readonly now = () => new Date(),
    readonly sleep: (ms: number) => Promise<unknown> = setTimeout,
    readonly rng = Math.random,
  ) {
    this.cursorName = `chain-${options.chainId}-${options.shop.toLowerCase()}`;
    if (
      options.maxRange <= options.rescanBlocks + 1 ||
      options.minRange > options.maxRange
    )
      throw new Error(
        'MAX_RANGE must exceed overlap and be at least MIN_RANGE',
      );
  }
  async scanOnce(): Promise<{ number: bigint; hash: string }> {
    const head = await this.rpc(() => this.chain.getHead());
    const cursor = await this.db.cursor.findUnique({
      where: { name: this.cursorName },
    });
    let position = cursor?.blockNumber ?? 0n;
    if (
      cursor &&
      (await this.rpc(() => this.chain.getBlockHash(cursor.blockNumber))) !==
        cursor.blockHash
    ) {
      position = max(
        0n,
        min(position, head.number) - BigInt(this.options.rescanBlocks),
      );
      await this.db.incident.create({
        data: {
          kind: 'cursor_reorg',
          fromBlock: position,
          toBlock: cursor.blockNumber,
          whatHappened: 'The saved cursor block changed.',
          howHandled: 'Stepped back and rescanned the overlap.',
        },
      });
    }
    const from = max(0n, position - BigInt(this.options.rescanBlocks));
    let to = min(head.number, from + BigInt(this.options.maxRange) - 1n);
    if (from > to) return head;
    let logs: TransferLog[] = [];
    let failure: RpcError | undefined;
    while (true) {
      try {
        logs = await this.rpc(() => this.chain.getTransferLogs(from, to));
        break;
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        const size = to - from + 1n;
        if (
          error.kind === 'range_too_large' &&
          size > BigInt(this.options.minRange)
        ) {
          to = from + max(BigInt(this.options.minRange), size / 2n) - 1n;
          continue;
        }
        failure = error;
        break;
      }
    }
    const blockHash =
      to === head.number
        ? head.hash
        : await this.rpc(() => this.chain.getBlockHash(to));
    if (!blockHash) throw new RpcError('transient');
    await this.db.$transaction(async (tx) => {
      if (failure) {
        await tx.scanGap.create({
          data: {
            fromBlock: from,
            toBlock: to,
            errorCategory: failure.kind,
            attempts: 1,
            nextRetryAt: new Date(this.now().getTime() + 60000),
          },
        });
        await tx.incident.create({
          data: {
            kind: 'scan_gap',
            fromBlock: from,
            toBlock: to,
            whatHappened: `Log scan failed: ${failure.kind}.`,
            howHandled:
              'Saved a gap for bounded background recovery; continued tracking new blocks.',
          },
        });
      } else await this.storeLogs(tx, logs, from, to);
      await tx.cursor.upsert({
        where: { name: this.cursorName },
        create: { name: this.cursorName, blockNumber: to, blockHash },
        update: { blockNumber: to, blockHash },
      });
    });
    return head;
  }
  async rpc<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        const retry =
          error.kind !== 'permanent' &&
          error.kind !== 'range_too_large' &&
          attempt < this.options.rpcAttempts;
        await this.db.incident.create({
          data: {
            kind: 'rpc_failed',
            whatHappened: `RPC request failed: ${error.kind}.`,
            howHandled: retry
              ? 'Retry with bounded exponential backoff and service cooldown.'
              : 'Stopped immediate retries; log ranges enter the gap path and other work resumes on a later pass.',
          },
        });
        if (!retry) throw error;
        await this.sleep(
          Math.floor(1000 * 2 ** (attempt - 1) * (0.5 + this.rng() / 2)),
        );
      }
    }
  }
  async storeLogs(
    tx: Prisma.TransactionClient,
    logs: TransferLog[],
    from: bigint,
    to: bigint,
  ): Promise<void> {
    for (const log of logs) {
      if (
        log.blockNumber < from ||
        log.blockNumber > to ||
        log.to.toLowerCase() !== this.options.shop.toLowerCase()
      )
        throw new Error('Provider returned a log outside the requested filter');
      const externalKey = `${this.options.chainId}:${log.txHash.toLowerCase()}:${log.logIndex}`;
      const exists = await tx.payment.findUnique({
        where: { provider_externalKey: { provider: 'chain', externalKey } },
      });
      if (exists) {
        await tx.incident.create({
          data: {
            kind: 'duplicate',
            paymentId: exists.id,
            whatHappened: 'Transfer log seen again.',
            howHandled: 'Skipped the duplicate payment.',
          },
        });
        continue;
      }
      await tx.payment.create({
        data: {
          provider: 'chain',
          externalKey,
          chainId: this.options.chainId,
          transactionHash: log.txHash.toLowerCase(),
          logIndex: log.logIndex,
          amount: log.amount,
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
          stage: 'received',
          receivedAt: this.now(),
        },
      });
    }
  }
}
