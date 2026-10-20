import { createHash } from 'node:crypto';
import { catalogue } from '../../../libs/core/src/catalogue';
import { allocateOffset, expectedAmount } from '../../../libs/core/src/amounts';
import {
  dailyTarget,
  shouldBuyThisMinute,
  type Budget,
} from '../../../libs/core/src/pacing';
import {
  BudgetReservation,
  type Prisma,
  type PrismaClient,
} from '../../../libs/db/src';

type Options = {
  cap: Budget;
  seed: string;
  ttlMinutes: number;
  quietStart: number;
  quietEnd: number;
};
export function utcDay(now: Date): Date {
  return new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
}
function minuteId(now: Date): string {
  const hex = createHash('sha256')
    .update(`purchase:${now.toISOString().slice(0, 16)}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
export class Purchases {
  constructor(
    private readonly db: PrismaClient,
    private readonly options: Options,
    private readonly rng = Math.random,
  ) {}
  async ensureBudget(now: Date) {
    const day = utcDay(now);
    const target = dailyTarget(this.options.cap, day, this.options.seed);
    await this.db.$executeRaw`
      INSERT INTO daily_budgets (day, target_count, target_amount)
      VALUES (${day.toISOString().slice(0, 10)}::date, ${target.count}, ${target.amount})
      ON CONFLICT (day) DO NOTHING
    `;
    return this.db.dailyBudget.findUniqueOrThrow({ where: { day } });
  }
  async pace(now: Date) {
    const id = minuteId(now);
    const existing = await this.db.order.findUnique({ where: { id } });
    if (existing) return existing;
    const budget = await this.ensureBudget(now);
    const average =
      catalogue.reduce((sum, item) => sum + item.priceCents * 10000n, 0n) /
        BigInt(catalogue.length) +
      5000n;
    const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    const quiet = (hour: number) =>
      this.options.quietStart < this.options.quietEnd
        ? hour >= this.options.quietStart && hour < this.options.quietEnd
        : this.options.quietStart > this.options.quietEnd &&
          (hour >= this.options.quietStart || hour < this.options.quietEnd);
    let activeMinutesLeft = 0;
    for (let m = minute; m < 1440; m++)
      if (!quiet(Math.floor(m / 60))) activeMinutesLeft++;
    if (
      !shouldBuyThisMinute(
        {
          count: budget.targetCount - budget.reservedCount,
          amount: budget.targetAmount - budget.reservedAmount,
        },
        average,
        Math.max(1, activeMinutesLeft),
        quiet(now.getUTCHours()),
        this.rng,
      )
    )
      return null;
    return this.create('schedule', id, now);
  }
  visitor(orderId: string, now = new Date()) {
    return this.create('visitor', orderId, now);
  }
  private async create(source: 'visitor' | 'schedule', id: string, now: Date) {
    await this.ensureBudget(now);
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(84532001)`;
      const existing = await tx.order.findUnique({ where: { id } });
      if (existing) return existing;
      return this.reserveOrder(tx, source, id, now);
    });
  }
  private async reserveOrder(
    tx: Prisma.TransactionClient,
    source: 'visitor' | 'schedule',
    id: string,
    now: Date,
  ) {
    const item = catalogue[Math.floor(this.rng() * catalogue.length)];
    if (!item)
      throw new RangeError('Random source must return a number in [0, 1)');
    const recent = await tx.order.findMany({
      where: { createdAt: { gte: new Date(now.getTime() - 86400000) } },
      select: { expectedAmount: true },
    });
    const taken = new Set(
      recent.map((order) => Number(order.expectedAmount % 10000n)),
    );
    const amount = expectedAmount(
      item.priceCents,
      allocateOffset(taken, this.rng),
    );
    if (!(await new BudgetReservation(tx).reserve(utcDay(now), amount)))
      return null;
    return tx.order.create({
      data: {
        id,
        item: item.name,
        price: item.priceCents * 10000n,
        expectedAmount: amount,
        source,
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.options.ttlMinutes * 60000),
      },
    });
  }
}
