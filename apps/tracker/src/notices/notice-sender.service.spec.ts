import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { verifyNotice } from '../../../../libs/core/src/notices';
import {
  fixture,
  clear,
  TrackerChain,
  log,
  now,
  options,
  order,
} from '../../testing/fixtures';
import { ScannerService } from '../scanning/scanner.service';
import { ProgressService } from '../scanning/progress.service';
import { DeliveryService } from '../delivery/delivery.service';
import { NoticeSenderService } from './notice-sender.service';
import { testRedisUrl } from '../../../../libs/config/testing/redis';
let f: Awaited<ReturnType<typeof fixture>>;
let server: Server;
let url: string;
let reject = false;
let unavailable = false;
const accepted = new Set<string>();
const secret = 'test-notice-secret-01234567890123456789';
beforeAll(async () => {
  f = await fixture();
  server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (part: string) => {
      body += part;
    });
    request.on('end', () => {
      if (unavailable) {
        unavailable = false;
        response.writeHead(503).end();
        return;
      }
      const timestamp = Number(request.headers['x-notice-timestamp']);
      const signature = String(request.headers['x-notice-signature']);
      if (
        reject ||
        !verifyNotice(
          body,
          secret,
          timestamp,
          signature,
          Math.floor(now.getTime() / 1000),
        )
      ) {
        response.writeHead(401).end();
        return;
      }
      accepted.add((JSON.parse(body) as { paymentId: string }).paymentId);
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test listener');
  url = `http://127.0.0.1:${address.port}/shop/notices`;
});
afterAll(async () => {
  await new Promise<void>((resolve, fail) =>
    server.close((error) => (error ? fail(error) : resolve())),
  );
  await f.close();
});
beforeEach(async () => {
  await clear(f.db);
  reject = false;
  unavailable = false;
  accepted.clear();
  f.chain = new TrackerChain();
  f.chain.logs = [log()];
  await order(f.db);
  const scanner = new ScannerService(f.db, f.chain, options, () => now);
  await scanner.scanOnce();
  await new ProgressService(f.db, scanner, () => now).advance(20n);
});
it('posts a verifiable timestamped HMAC notice and records successful delivery once', async () => {
  const sender = new NoticeSenderService(f.db, { url, secret }, () => now);
  const payment = await f.db.payment.findFirstOrThrow();
  await sender.send(payment.id);
  await sender.send(payment.id);
  expect(accepted).toEqual(new Set([payment.id]));
  expect(await f.db.notice.findFirstOrThrow()).toMatchObject({
    attempts: 1,
    deliveredAt: now,
  });
});
it('keeps a rejected notice undelivered with a handling incident', async () => {
  reject = true;
  const payment = await f.db.payment.findFirstOrThrow();
  await expect(
    new NoticeSenderService(f.db, { url, secret }, () => now).send(
      payment.id,
      true,
    ),
  ).rejects.toThrow('Shop notice delivery failed');
  expect(await f.db.notice.findFirstOrThrow()).toMatchObject({
    attempts: 1,
    deliveredAt: null,
  });
  expect(
    (await f.db.incident.findFirstOrThrow({ where: { kind: 'notice_failed' } }))
      .howHandled,
  ).toContain('manual review');
});
it('retries a shop outage through BullMQ and delivers the same payment after recovery', async () => {
  unavailable = true;
  const connection = { url: testRedisUrl() };
  const name = `notice-retries-${randomUUID()}`;
  const queue = new Queue<{ paymentId: string }>(name, { connection });
  const sender = new NoticeSenderService(f.db, { url, secret }, () => now);
  const worker = new Worker<{ paymentId: string }>(
    name,
    (job) =>
      sender.send(
        job.data.paymentId,
        job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
      ),
    { connection, autorun: false },
  );
  try {
    const complete = new Promise<void>((resolve, fail) => {
      worker.once('completed', () => resolve());
      worker.once('error', fail);
    });
    await new DeliveryService(
      f.db,
      { publish: async () => 0 },
      queue,
      () => now,
    ).flush();
    void worker.run();
    await complete;
    expect(await f.db.notice.findFirstOrThrow()).toMatchObject({
      attempts: 2,
      deliveredAt: now,
    });
    expect(accepted).toEqual(
      new Set([(await f.db.payment.findFirstOrThrow()).id]),
    );
    expect(
      await f.db.incident.count({ where: { kind: 'notice_failed' } }),
    ).toBe(1);
  } finally {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
  }
});
