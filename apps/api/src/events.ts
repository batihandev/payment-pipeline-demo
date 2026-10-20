import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { subscribePayments } from '../../../libs/events/src/subscribe-payments';
export async function registerEvents(
  app: FastifyInstance,
  redis: Redis,
): Promise<void> {
  const clients = new Set<PassThrough>();
  const unsubscribe = await subscribePayments(redis, (body) => {
    for (const stream of clients)
      if (!stream.write(`data: ${body}\n\n`)) stream.destroy();
  });
  app.get('/events', (_request, reply) => {
    const stream = new PassThrough();
    clients.add(stream);
    const heartbeat = setInterval(() => {
      if (!stream.write(': heartbeat\n\n')) stream.destroy();
    }, 15000);
    heartbeat.unref();
    stream.once('close', () => {
      clearInterval(heartbeat);
      clients.delete(stream);
    });
    reply.raw.once('close', () => stream.destroy());
    stream.write(': connected\n\n');
    return reply
      .header('content-type', 'text/event-stream')
      .header('cache-control', 'no-cache')
      .header('x-accel-buffering', 'no')
      .send(stream);
  });
  app.addHook('preClose', async () => {
    for (const stream of clients) stream.destroy();
    await unsubscribe();
  });
}
