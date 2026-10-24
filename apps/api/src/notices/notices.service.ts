import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/db';
import { savePaymentEvent } from '@app/events/save-payment-event';
import { ApiError } from '../common/api-error';
import { InjectNow, type Now } from '../common/clock.module';

@Injectable()
export class NoticesService {
  constructor(
    private readonly db: PrismaService,
    @InjectNow() private readonly now: Now,
  ) {}

  /** Marks a settled payment as notified; repeating the notice for it is accepted. */
  async deliver(paymentId: string): Promise<void> {
    const status = await this.db.$transaction(async (tx) => {
      const changed = await tx.payment.updateMany({
        where: { id: paymentId, stage: 'settled', notifiedAt: null },
        data: { stage: 'notified', notifiedAt: this.now() },
      });
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) return 404;
      if (changed.count === 0) return payment.stage === 'notified' ? 200 : 409;
      await tx.notice.upsert({
        where: { paymentId },
        create: { paymentId, deliveredAt: this.now() },
        update: { deliveredAt: this.now() },
      });
      await savePaymentEvent(tx, payment);
      return 200;
    });
    if (status === 404) throw new ApiError(404, 'payment_not_found');
    if (status === 409) throw new ApiError(409, 'payment_not_settled');
  }
}
