import type { PrismaClient } from '../../../libs/db/src';
import type { Scanner } from './scanner';
import type { PaymentProgress } from './progress';
export class TrackerPoller {
  constructor(
    readonly db: PrismaClient,
    readonly scanner: Scanner,
    readonly progress: PaymentProgress,
    readonly intervals: { active: number; idle: number },
    readonly rng = Math.random,
  ) {}
  async pass(): Promise<number> {
    const head = await this.scanner.scanOnce();
    const finalized = await this.scanner.rpc(() =>
      this.scanner.chain.getFinalized(),
    );
    await this.progress.advance(head.number, finalized);
    const [open, pending, cursor] = await Promise.all([
      this.db.order.count({ where: { status: 'open' } }),
      this.db.payment.count({
        where: {
          provider: 'chain',
          chainId: this.scanner.options.chainId,
          OR: [{ final: false }, { stage: { notIn: ['settled', 'notified'] } }],
        },
      }),
      this.db.cursor.findUnique({ where: { name: this.scanner.cursorName } }),
    ]);
    const active =
      open > 0 || pending > 0 || !cursor || cursor.blockNumber < head.number;
    return Math.round(
      (active ? this.intervals.active : this.intervals.idle) *
        (0.9 + this.rng() * 0.2),
    );
  }
}
