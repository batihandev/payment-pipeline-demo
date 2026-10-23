import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../libs/db/src';

@Injectable()
export class ExpiryService {
  constructor(private readonly db: PrismaService) {}

  async expireOrders(now: Date): Promise<number> {
    const result = await this.db.order.updateMany({
      where: { status: 'open', expiresAt: { lte: now } },
      data: { status: 'expired' },
    });
    return result.count;
  }
}
