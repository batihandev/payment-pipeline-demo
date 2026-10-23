import { Injectable, Optional } from '@nestjs/common';
import {
  OrderQueueService,
  PurchasesService,
} from '../../../../libs/orders/src';

@Injectable()
export class PaceService {
  constructor(
    private readonly purchases: PurchasesService,
    private readonly orderQueue: OrderQueueService,
    @Optional() private readonly rng = Math.random,
  ) {}

  async pace(now: Date) {
    const order = await this.purchases.pace(now);
    if (order)
      await this.orderQueue.queueSend(
        order.id,
        'schedule',
        Math.floor(
          this.rng() *
            (60000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds()),
        ),
      );
    return order;
  }
}
