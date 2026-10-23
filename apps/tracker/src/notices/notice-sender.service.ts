import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService, recordIncident } from '../../../../libs/db/src';
import type { TrackerConfig } from '../tracker-config';
import { noticeRetryOptions } from './notice-retry';
import { signNotice } from '../../../../libs/core/src/notices';
@Injectable()
export class NoticeSenderService {
  private readonly url: string;
  private readonly secret: string;

  constructor(
    private readonly db: PrismaService,
    config: ConfigService<TrackerConfig, true>,
    @Optional() private readonly now = () => new Date(),
  ) {
    this.url = config.get('SHOP_NOTICE_URL', { infer: true });
    this.secret = config.get('NOTICE_SECRET', { infer: true });
  }
  async send(paymentId: string, exhausted = false): Promise<void> {
    const notice = await this.db.notice.findUniqueOrThrow({
      where: { paymentId },
    });
    if (notice.deliveredAt || notice.attempts >= noticeRetryOptions.attempts)
      return;
    await this.db.notice.update({
      where: { paymentId },
      data: { attempts: { increment: 1 } },
    });
    const body = JSON.stringify({ paymentId });
    const timestamp = Math.floor(this.now().getTime() / 1000);
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-notice-timestamp': String(timestamp),
          'x-notice-signature': signNotice(body, this.secret, timestamp),
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
      await recordIncident(this.db, {
        kind: 'notice_failed',
        paymentId,
        whatHappened: 'The shop notice could not be delivered.',
        howHandled: exhausted
          ? 'Kept the undelivered notice for manual review after retries were exhausted.'
          : 'Kept the notice for a bounded queue retry with exponential backoff.',
      });
      throw new Error('Shop notice delivery failed');
    }
  }
}
