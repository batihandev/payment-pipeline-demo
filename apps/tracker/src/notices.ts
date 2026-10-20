import type { PrismaClient } from '../../../libs/db/src';
import { signNotice } from '../../../libs/core/src/notices';
export class NoticeSender {
  constructor(
    readonly db: PrismaClient,
    readonly config: { url: string; secret: string },
    readonly now = () => new Date(),
  ) {}
  async send(paymentId: string, exhausted = false): Promise<void> {
    const notice = await this.db.notice.findUniqueOrThrow({
      where: { paymentId },
    });
    if (notice.deliveredAt) return;
    await this.db.notice.update({
      where: { paymentId },
      data: { attempts: { increment: 1 } },
    });
    const body = JSON.stringify({ paymentId });
    const timestamp = Math.floor(this.now().getTime() / 1000);
    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-notice-timestamp': String(timestamp),
          'x-notice-signature': signNotice(body, this.config.secret, timestamp),
        },
        body,
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Shop rejected notice');
      await this.db.notice.update({
        where: { paymentId },
        data: { deliveredAt: this.now() },
      });
    } catch {
      await this.db.incident.create({
        data: {
          kind: 'notice_failed',
          paymentId,
          whatHappened: 'The shop notice could not be delivered.',
          howHandled: exhausted
            ? 'Kept the undelivered notice for manual review after retries were exhausted.'
            : 'Kept the notice for a bounded queue retry with exponential backoff.',
        },
      });
      throw new Error('Shop notice delivery failed');
    }
  }
}
