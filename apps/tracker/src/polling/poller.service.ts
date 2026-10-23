import { setTimeout } from 'node:timers/promises';
import {
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../../libs/db/src';
import { ScannerService } from '../scanning/scanner.service';
import { ProgressService } from '../scanning/progress.service';
import type { TrackerConfig } from '../tracker-config';
@Injectable()
export class PollerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly stopped = new AbortController();
  private readonly intervals: { active: number; idle: number };
  private loop: Promise<void> | undefined;

  constructor(
    private readonly db: PrismaService,
    private readonly scanner: ScannerService,
    private readonly progress: ProgressService,
    config: ConfigService<TrackerConfig, true>,
    @Optional() private readonly rng = Math.random,
  ) {
    this.intervals = {
      active: config.get('ACTIVE_POLL_MS', { infer: true }),
      idle: config.get('IDLE_POLL_MS', { infer: true }),
    };
  }

  onApplicationBootstrap(): void {
    this.loop = this.poll();
  }

  /** Runs before the global Redis and database modules are destroyed. */
  async onModuleDestroy(): Promise<void> {
    this.stopped.abort();
    await this.loop;
  }

  private async poll(): Promise<void> {
    while (!this.stopped.signal.aborted) {
      let delay = this.intervals.active;
      try {
        delay = await this.pass();
      } catch {
        try {
          await this.db.incident.create({
            data: {
              kind: 'tracker_pass_failed',
              whatHappened: 'The tracker pass could not finish.',
              howHandled:
                'Retained database state and scheduled the next poll.',
            },
          });
        } catch {
          console.error('Tracker database connection failed.');
        }
      }
      try {
        await setTimeout(delay, undefined, { signal: this.stopped.signal });
      } catch {
        break;
      }
    }
  }

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
