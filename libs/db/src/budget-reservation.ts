import { utcDateKey } from '../../core/src/time';
import type { Prisma } from '../generated/client';

export class BudgetReservation {
  constructor(
    private readonly db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  ) {}

  async reserve(day: Date, amount: bigint): Promise<boolean> {
    if (amount <= 0n)
      throw new RangeError('Reservation amount must be positive');
    const rows = await this.db.$queryRaw<{ day: Date }[]>`
      UPDATE daily_budgets
      SET reserved_count = reserved_count + 1,
          reserved_amount = reserved_amount + ${amount}
      WHERE day = ${utcDateKey(day)}::date
        AND reserved_count < target_count
        AND reserved_amount + ${amount} <= target_amount
      RETURNING day
    `;
    return rows.length === 1;
  }

  /**
   * Takes a released reservation back without checking the targets, for a payment that went
   * through after its order was closed: the money is spent either way.
   */
  async restore(day: Date, amount: bigint): Promise<void> {
    if (amount <= 0n) throw new RangeError('Restore amount must be positive');
    await this.db.$queryRaw`
      UPDATE daily_budgets
      SET reserved_count = reserved_count + 1,
          reserved_amount = reserved_amount + ${amount}
      WHERE day = ${utcDateKey(day)}::date
      RETURNING day
    `;
  }

  async release(day: Date, amount: bigint): Promise<void> {
    if (amount <= 0n) throw new RangeError('Release amount must be positive');
    await this.db.$queryRaw`
      UPDATE daily_budgets
      SET reserved_count = reserved_count - 1,
          reserved_amount = reserved_amount - ${amount}
      WHERE day = ${utcDateKey(day)}::date
        AND reserved_count > 0
        AND reserved_amount >= ${amount}
      RETURNING day
    `;
  }
}
