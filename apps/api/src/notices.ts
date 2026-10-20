import type { RawBodyRequest } from '@nestjs/common';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '../../../libs/db/src';
import { verifyNotice } from '../../../libs/core/src/notices';
import { savePaymentEvent } from '../../../libs/events/src/save-payment-event';
const noticeBody = z.strictObject({ paymentId: z.uuid() });
export function registerNotices(
  app: FastifyInstance,
  db: PrismaClient,
  secret: string,
  now = () => new Date(),
): void {
  app.post('/shop/notices', { bodyLimit: 4096 }, async (request, reply) => {
    const raw = (request as RawBodyRequest<FastifyRequest>).rawBody;
    const timestamp = request.headers['x-notice-timestamp'];
    const signature = request.headers['x-notice-signature'];
    if (
      !raw ||
      typeof timestamp !== 'string' ||
      !/^\d+$/.test(timestamp) ||
      typeof signature !== 'string' ||
      !verifyNotice(
        raw.toString('utf8'),
        secret,
        Number(timestamp),
        signature,
        Math.floor(now().getTime() / 1000),
      )
    )
      return reply.code(401).send({ error: 'invalid_notice_signature' });
    const parsed = noticeBody.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid_notice_body' });
    const { paymentId } = parsed.data;
    const status = await db.$transaction(async (tx) => {
      const changed = await tx.payment.updateMany({
        where: { id: paymentId, stage: 'settled', notifiedAt: null },
        data: { stage: 'notified', notifiedAt: now() },
      });
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) return 404;
      if (changed.count === 0) return payment.stage === 'notified' ? 200 : 409;
      await tx.notice.upsert({
        where: { paymentId },
        create: { paymentId, deliveredAt: now() },
        update: { deliveredAt: now() },
      });
      await savePaymentEvent(tx, payment);
      return 200;
    });
    return reply.code(status).send(
      status === 200
        ? { ok: true }
        : {
            error: status === 404 ? 'payment_not_found' : 'payment_not_settled',
          },
    );
  });
}
