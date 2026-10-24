import { Injectable, Optional } from '@nestjs/common';
import { PrismaService, recordIncident } from '@app/db';
import { ScannerService } from '../scanning/scanner.service';
@Injectable()
export class GapRecoveryService {
  constructor(
    private readonly db: PrismaService,
    private readonly scanner: ScannerService,
    @Optional() private readonly now = () => new Date(),
  ) {}

  async retryOnce(): Promise<void> {
    const gap = await this.db.scanGap.findFirst({
      where: {
        resolvedAt: null,
        attempts: { lt: this.scanner.options.gapAttempts },
        nextRetryAt: { lte: this.now() },
        errorCategory: { not: 'permanent' },
      },
      orderBy: { nextRetryAt: 'asc' },
    });
    if (!gap) return;
    await this.db.scanGap.update({
      where: { id: gap.id },
      data: {
        attempts: { increment: 1 },
        nextRetryAt: new Date(this.now().getTime() + 60000 * 2 ** gap.attempts),
      },
    });
    const end = gap.fromBlock + BigInt(this.scanner.options.maxRange) - 1n;
    const range = await this.scanner.readRange(
      gap.fromBlock,
      end < gap.toBlock ? end : gap.toBlock,
    );
    await this.db.$transaction(async (tx) => {
      if (range.failure) {
        await tx.scanGap.update({
          where: { id: gap.id },
          data: { errorCategory: range.failure.kind },
        });
        await recordIncident(tx, {
          kind: 'gap_retry_failed',
          fromBlock: gap.fromBlock,
          toBlock: gap.toBlock,
          whatHappened: `Gap retry failed: ${range.failure.kind}.`,
          howHandled:
            gap.attempts + 1 >= this.scanner.options.gapAttempts ||
            range.failure.kind === 'permanent'
              ? 'Left the gap open for manual review; stopped automatic retries.'
              : 'Left the gap open with exponential backoff.',
        });
        return;
      }
      await this.scanner.storeLogs(tx, range.logs, gap.fromBlock, range.to);
      const complete = range.to === gap.toBlock;
      await tx.scanGap.update({
        where: { id: gap.id },
        data: complete
          ? { resolvedAt: this.now() }
          : { fromBlock: range.to + 1n, attempts: 0, nextRetryAt: this.now() },
      });
      await recordIncident(tx, {
        kind: complete ? 'gap_recovered' : 'gap_progress',
        fromBlock: gap.fromBlock,
        toBlock: range.to,
        whatHappened: 'A previously unscanned range became available.',
        howHandled: complete
          ? 'Stored recovered payments and closed the gap in one transaction.'
          : 'Stored the recovered portion and retained the unscanned remainder.',
      });
    });
  }
}
