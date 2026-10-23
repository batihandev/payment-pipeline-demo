import { handlePaymentReorg } from './payment-reorg';
import { savePaymentEvent } from '../../../../libs/events/src/save-payment-event';
import { receiveTransfer } from './matching';
import { setTimeout } from 'node:timers/promises';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChainClient,
  type TransferLog,
} from '../../../../libs/chain/src/chain-client';
import { RpcError } from '../../../../libs/chain/src/rpc-error';
import { PrismaService, type Prisma } from '../../../../libs/db/src';
import type { TrackerConfig } from '../tracker-config';
export type TrackerOptions = {
  startBlock?: bigint;
  chainId: number;
  shop: string;
  buyer: string;
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
@Injectable()
export class ScannerService {
  readonly cursorName: string;
  readonly options: TrackerOptions;
  /** The public RPC endpoint is load-balanced and some backends answer with an older head. */
  private highestHead: { number: bigint; hash: string } | undefined;
  constructor(
    private readonly db: PrismaService,
    @Inject(ChainClient) readonly chain: TrackerChain,
    config: ConfigService<TrackerConfig, true>,
    @Optional() private readonly now = () => new Date(),
    @Optional()
    private readonly sleep: (ms: number) => Promise<unknown> = setTimeout,
    @Optional() private readonly rng = Math.random,
  ) {
    const get = <K extends keyof TrackerConfig>(key: K) =>
      config.get(key, { infer: true });
    const options: TrackerOptions = {
      startBlock: get('START_BLOCK'),
      chainId: get('CHAIN_ID'),
      shop: get('SHOP_ADDRESS'),
      buyer: get('BUYER_ADDRESS'),
      maxRange: get('MAX_RANGE'),
      minRange: get('MIN_RANGE'),
      rescanBlocks: get('RESCAN_BLOCKS'),
      rpcAttempts: get('RPC_MAX_ATTEMPTS'),
      gapAttempts: get('GAP_MAX_ATTEMPTS'),
      confirmations: get('CONFIRMATIONS'),
    };
    this.options = options;
    this.cursorName = `chain-${options.chainId}-${options.shop.toLowerCase()}`;
    if (
      options.maxRange <= options.rescanBlocks + 1 ||
      options.minRange > options.maxRange ||
      options.minRange <= options.rescanBlocks + 1
    )
      throw new Error(
        'MIN_RANGE must exceed RESCAN_BLOCKS + 1; MAX_RANGE must be at least MIN_RANGE',
      );
  }
  async scanOnce(): Promise<{ number: bigint; hash: string }> {
    const fetched = await this.rpc(() => this.chain.getHead());
    if (!this.highestHead || fetched.number > this.highestHead.number)
      this.highestHead = fetched;
    const head = this.highestHead;
    const cursor = await this.db.cursor.findUnique({
      where: { name: this.cursorName },
    });
    let position =
      cursor?.blockNumber ??
      this.options.startBlock ??
      max(0n, head.number - BigInt(this.options.rescanBlocks));
    if (!cursor) {
      const blockHash =
        position === head.number
          ? head.hash
          : await this.rpc(() => this.chain.getBlockHash(position));
      if (!blockHash) throw new RpcError('transient');
      // One statement, so two first scans cannot both insert: the loser leaves the winner's row.
      await this.db.$executeRaw`
        INSERT INTO cursors (name, block_number, block_hash)
        VALUES (${this.cursorName}, ${position}, ${blockHash})
        ON CONFLICT (name) DO NOTHING`;
      const initialized = await this.db.cursor.findUniqueOrThrow({
        where: { name: this.cursorName },
      });
      position = initialized.blockNumber;
    }
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
    const from = cursor
      ? max(0n, position - BigInt(this.options.rescanBlocks))
      : position;
    let to = min(head.number, from + BigInt(this.options.maxRange) - 1n);
    if (from > to) return head;
    const range = await this.readRange(from, to);
    to = range.to;
    const { logs, failure } = range;
    const blockHash =
      to === head.number
        ? head.hash
        : await this.rpc(() => this.chain.getBlockHash(to));
    if (!blockHash) throw new RpcError('transient');
    await this.db.$transaction(async (tx) => {
      if (failure) {
        const existingGap = await tx.scanGap.findFirst({
          where: { fromBlock: from, toBlock: to, resolvedAt: null },
        });
        if (!existingGap)
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
      } else await this.storeLogs(tx, logs, from, to, cursor?.blockNumber);
      // advancedAt moves only with a higher block, so a rescan of the same blocks or a step
      // back after a reorg does not look like progress.
      const advanced = await tx.cursor.updateMany({
        where: { name: this.cursorName, blockNumber: { lt: to } },
        data: { blockNumber: to, blockHash, advancedAt: this.now() },
      });
      if (advanced.count === 0)
        // A cursor already at or past `to` is set to `to` without moving advancedAt; as one
        // statement, this cannot collide with another scan's first insert.
        await tx.$executeRaw`
          INSERT INTO cursors (name, block_number, block_hash)
          VALUES (${this.cursorName}, ${to}, ${blockHash})
          ON CONFLICT (name) DO UPDATE
          SET block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash`;
    });
    return head;
  }
  async readRange(from: bigint, end: bigint) {
    let to = end;
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
    return { to, logs, failure };
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
    rereadThrough?: bigint,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${this.cursorName}, 0))`;
    for (const log of logs) {
      if (
        log.blockNumber < from ||
        log.blockNumber > to ||
        log.to.toLowerCase() !== this.options.shop.toLowerCase()
      )
        throw new Error('Provider returned a log outside the requested filter');
      const externalKey = `${this.options.chainId}:${log.txHash.toLowerCase()}:${log.logIndex}`;
      const relocated = await tx.payment.findMany({
        where: {
          provider: 'chain',
          chainId: this.options.chainId,
          transactionHash: log.txHash.toLowerCase(),
          blockHash: { not: log.blockHash },
        },
      });
      let heldCredit = false;
      for (const previous of relocated) {
        if (await handlePaymentReorg(tx, previous, this.now()))
          heldCredit = true;
      }
      if (heldCredit) continue;
      const exists = await tx.payment.findUnique({
        where: { provider_externalKey: { provider: 'chain', externalKey } },
      });
      if (exists && exists.stage === 'sent' && exists.blockNumber === null) {
        const restored = await tx.payment.update({
          where: { id: exists.id },
          data: {
            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            logIndex: log.logIndex,
            stage: 'received',
            receivedAt: this.now(),
          },
        });
        await savePaymentEvent(tx, restored);
        continue;
      }
      if (
        exists &&
        rereadThrough !== undefined &&
        exists.blockHash === log.blockHash &&
        exists.blockNumber !== null &&
        exists.blockNumber <= rereadThrough
      )
        continue;
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
      await receiveTransfer(
        tx,
        log,
        this.options.chainId,
        externalKey,
        this.now(),
        this.options.buyer,
      );
    }
  }
}
