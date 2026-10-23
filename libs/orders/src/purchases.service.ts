import type { z } from 'zod';
import type { buyerSchema } from '../../config/src';
import { createHash } from 'node:crypto';
import { DAY_MS, utcDateKey, utcDay } from '../../core/src/time';
import { catalogue } from '../../core/src/catalogue';
import { allocateOffset, expectedAmount } from '../../core/src/amounts';
import {
  dailyTarget,
  shouldBuyThisMinute,
  type Budget,
} from '../../core/src/pacing';
import {
  BudgetReservation,
  type PaymentRail,
  type Prisma,
  type PrismaClient,
} from '../../db/src';
import { CustomersService, hasSavedCard } from './customers.service';

type Customer = Awaited<ReturnType<CustomersService['demo']>>;
type Options = {
  cap: Budget;
  seed: string;
  ttlMinutes: number;
  quietStart: number;
  quietEnd: number;
  /** Whether scheduled purchases may use the card rail: the buyer has a Stripe key. */
  cardRail: boolean;
};
function minuteId(now: Date): string {
  const hex = createHash('sha256')
    .update(`purchase:${now.toISOString().slice(0, 16)}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
function paidByCard(orderId: string): boolean {
  return createHash('sha256').update(orderId).digest().readUInt8(0) % 3 === 0;
}
export class PurchasesService {
  constructor(
    private readonly db: PrismaClient,
    private readonly options: Options,
    private readonly rng: () => number,
    private readonly customers: CustomersService,
  ) {}
  async ensureBudget(now: Date) {
    const day = utcDay(now);
    const target = dailyTarget(this.options.cap, day, this.options.seed);
    await this.db.$executeRaw`
      INSERT INTO daily_budgets (day, target_count, target_amount)
      VALUES (${utcDateKey(day)}::date, ${target.count}, ${target.amount})
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
    const customer = await this.customers.demo();
    return this.create(
      'schedule',
      id,
      now,
      undefined,
      this.options.cardRail && hasSavedCard(customer) && paidByCard(id)
        ? 'card'
        : 'chain',
      customer,
    );
  }
  async visitor(
    orderId: string,
    rail: PaymentRail,
    now: Date,
    dailyLimit?: number,
  ) {
    return this.create(
      'visitor',
      orderId,
      now,
      dailyLimit,
      rail,
      await this.customers.demo(),
    );
  }
  visitorsToday(now: Date) {
    return this.countVisitors(this.db, now);
  }
  private countVisitors(
    db: Prisma.TransactionClient | PrismaClient,
    now: Date,
  ) {
    const start = utcDay(now);
    return db.order.count({
      where: {
        source: 'visitor',
        createdAt: { gte: start, lt: new Date(start.getTime() + DAY_MS) },
      },
    });
  }
  private async create(
    source: 'visitor' | 'schedule',
    id: string,
    now: Date,
    dailyLimit: number | undefined,
    rail: PaymentRail,
    customer: Customer,
  ) {
    await this.ensureBudget(now);
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(84532001)`;
      const existing = await tx.order.findUnique({ where: { id } });
      if (existing) return existing;
      if (
        source === 'visitor' &&
        dailyLimit !== undefined &&
        (await this.countVisitors(tx, now)) >= dailyLimit
      )
        return null;
      return this.reserveOrder(tx, source, id, now, rail, customer?.id);
    });
  }
  private async reserveOrder(
    tx: Prisma.TransactionClient,
    source: 'visitor' | 'schedule',
    id: string,
    now: Date,
    rail: PaymentRail,
    customerId: string | undefined,
  ) {
    const item = catalogue[Math.floor(this.rng() * catalogue.length)];
    if (!item)
      throw new RangeError('Random source must return a number in [0, 1)');
    const recent = await tx.order.findMany({
      where: {
        rail: 'chain',
        createdAt: { gte: new Date(now.getTime() - DAY_MS) },
      },
      select: { expectedAmount: true },
    });
    const taken = new Set(
      recent.map((order) => Number(order.expectedAmount % 10000n)),
    );
    const amount =
      rail === 'card'
        ? item.priceCents * 10000n
        : expectedAmount(item.priceCents, allocateOffset(taken, this.rng));
    if (
      source === 'schedule' &&
      !(await new BudgetReservation(tx).reserve(utcDay(now), amount))
    )
      return null;
    return tx.order.create({
      data: {
        id,
        item: item.name,
        price: item.priceCents * 10000n,
        expectedAmount: amount,
        source,
        rail,
        customerId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.options.ttlMinutes * 60000),
      },
    });
  }
}

export function purchaseOptions(
  config: Pick<
    z.output<typeof buyerSchema>,
    | 'DAILY_COUNT_CAP'
    | 'DAILY_AMOUNT_CAP'
    | 'CHAIN_ID'
    | 'ORDER_TTL_MINUTES'
    | 'QUIET_START_HOUR_UTC'
    | 'QUIET_END_HOUR_UTC'
    | 'STRIPE_SECRET_KEY'
  >,
): Options {
  return {
    cap: { count: config.DAILY_COUNT_CAP, amount: config.DAILY_AMOUNT_CAP },
    seed: String(config.CHAIN_ID),
    ttlMinutes: config.ORDER_TTL_MINUTES,
    quietStart: config.QUIET_START_HOUR_UTC,
    quietEnd: config.QUIET_END_HOUR_UTC,
    cardRail: Boolean(config.STRIPE_SECRET_KEY),
  };
}
