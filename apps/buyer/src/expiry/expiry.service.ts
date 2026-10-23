import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, type PrismaClient } from '../../../../libs/db/src';

@Injectable()
export class ExpiryService {
  constructor(@Inject(PrismaService) private readonly db: PrismaClient) {}

  async expireOrders(now: Date): Promise<number> {
    const result = await this.db.order.updateMany({
      where: { status: 'open', expiresAt: { lte: now } },
      data: { status: 'expired' },
    });
    return result.count;
  }
}
