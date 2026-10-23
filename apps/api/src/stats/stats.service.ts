import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../../libs/db/src';
import type { DailyStat, TodayStats } from '../../../../libs/core/src/api';
import { DAY_MS, utcDateKey, utcDay } from '../../../../libs/core/src/time';
import type { ApiConfig } from '../common/api-config';
import { InjectNow, type Now } from '../common/clock.module';
import { ttlCache } from '../common/ttl-cache';

type DailyStats = DailyStat[];

@Injectable()
export class StatsService {
  readonly today: () => Promise<TodayStats>;
  readonly daily: () => Promise<DailyStats>;

  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService<ApiConfig, true>,
    @InjectNow() private readonly now: Now,
  ) {
    const clock = () => this.now().getTime();
    this.today = ttlCache(5000, () => this.computeToday(), clock);
    this.daily = ttlCache(60000, () => this.computeDaily(), clock);
  }

  private async computeToday(): Promise<TodayStats> {
    const donationMin = this.config.get('DONATION_MIN', { infer: true });
    const from = utcDay(this.now());
    const to = new Date(from.getTime() + DAY_MS);
    const [rows, duplicatesSkipped, failuresRecovered] = await Promise.all([
      this.db.$queryRaw<
        { settledCount: bigint; averageTimeToSettleMs: number | null }[]
      >`SELECT COUNT(*)::bigint AS "settledCount", AVG(EXTRACT(EPOCH FROM (p.settled_at - COALESCE(p.sent_at, p.received_at))) * 1000)::float8 AS "averageTimeToSettleMs" FROM ledger_entries l JOIN payments p ON p.id = l.payment_id WHERE p.settled_at >= ${from} AND p.settled_at < ${to} AND NOT (p.donation AND p.amount < ${donationMin})`,
      this.db.incident.count({
        where: { kind: 'duplicate', createdAt: { gte: from, lt: to } },
      }),
      this.db.incident.count({
        where: { kind: 'gap_recovered', createdAt: { gte: from, lt: to } },
      }),
    ]);
    return {
      settledCount: Number(rows[0]?.settledCount ?? 0),
      averageTimeToSettleMs: rows[0]?.averageTimeToSettleMs ?? null,
      duplicatesSkipped,
      failuresRecovered,
    };
  }

  private async computeDaily(): Promise<DailyStats> {
    const donationMin = this.config.get('DONATION_MIN', { infer: true });
    const retentionDays = this.config.get('RETENTION_DAYS', { infer: true });
    const to = new Date(utcDay(this.now()).getTime() + DAY_MS);
    const from = new Date(to.getTime() - retentionDays * DAY_MS);
    const rows = await this.db.$queryRaw<
      {
        day: string;
        settled: bigint;
        scheduled: bigint;
        visitor: bigint;
        averageTimeToSettleMs: number | null;
      }[]
    >`SELECT to_char(p.settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::bigint AS settled, COUNT(*) FILTER (WHERE o.source = 'schedule')::bigint AS scheduled, COUNT(*) FILTER (WHERE o.source = 'visitor')::bigint AS visitor, AVG(EXTRACT(EPOCH FROM (p.settled_at - COALESCE(p.sent_at, p.received_at))) * 1000)::float8 AS "averageTimeToSettleMs" FROM ledger_entries l JOIN payments p ON p.id = l.payment_id LEFT JOIN orders o ON o.id = p.order_id WHERE p.settled_at >= ${from} AND p.settled_at < ${to} AND NOT (p.donation AND p.amount < ${donationMin}) GROUP BY 1`;
    const byDay = new Map(rows.map((row) => [row.day, row]));
    return Array.from({ length: retentionDays }, (_, index) => {
      const day = utcDateKey(new Date(from.getTime() + index * DAY_MS));
      const row = byDay.get(day);
      return {
        day,
        settled: Number(row?.settled ?? 0),
        scheduled: Number(row?.scheduled ?? 0),
        visitor: Number(row?.visitor ?? 0),
        averageTimeToSettleMs: row?.averageTimeToSettleMs ?? null,
      };
    });
  }
}
