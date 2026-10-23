import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../libs/db/src';
import { saveOrderEvents } from '../../../../libs/events/src/order-events';

@Injectable()
export class ExpiryService {
  constructor(private readonly db: PrismaService) {}

  async expireOrders(now: Date): Promise<number> {
    return this.db.$transaction(async (tx) => {
      const expired = await tx.order.updateManyAndReturn({
        where: { status: 'open', expiresAt: { lte: now } },
        data: { status: 'expired' },
        select: { id: true },
      });
      await saveOrderEvents(
        tx,
        expired.map(({ id }) => id),
      );
      return expired.length;
    });
  }
}
