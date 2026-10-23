import { DelayedError, type Job } from 'bullmq';
import type { BuyerJobData } from '../../../libs/queues/src';
import type {
  OrderQueueService,
  PurchasesService,
} from '../../../libs/orders/src';
import type { BuyerFunds } from './funds';
export const IN_FLIGHT_DELAY_MS = 500;
/** Puts a send back in the queue, without using an attempt, while the wallet is at its cap. */
export async function holdWhenFull(
  job: Job<BuyerJobData>,
  token: string | undefined,
  sender: { inFlight(): Promise<number> },
  maxInFlight: number,
): Promise<void> {
  if ((await sender.inFlight()) < maxInFlight) return;
  await job.moveToDelayed(Date.now() + IN_FLIGHT_DELAY_MS, token);
  throw new DelayedError();
}
export const SHORT_FUNDS_DELAY_MS = 2000;
/** Puts a send back in the queue, without using an attempt, until the buyer's balance can pay for it. */
export async function holdWhenShort(
  job: Job<BuyerJobData>,
  token: string | undefined,
  funds: Pick<BuyerFunds, 'covers'>,
  orderId: string,
): Promise<void> {
  if (await funds.covers(orderId)) return;
  await job.moveToDelayed(Date.now() + SHORT_FUNDS_DELAY_MS, token);
  throw new DelayedError();
}
export class BuyerJobs {
  constructor(
    private readonly purchases: PurchasesService,
    private readonly orderQueue: OrderQueueService,
    private readonly rng = Math.random,
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
