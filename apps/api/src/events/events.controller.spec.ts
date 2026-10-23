import { once } from 'node:events';
import { Logger, type MessageEvent } from '@nestjs/common';
import { Subject } from 'rxjs';
import { testDatabase } from '../../../../libs/db/testing/database';
import { createTestApp } from '../../testing/app';
import { openEventStream } from '../../testing/event-stream';
import { EventsService } from './events.service';

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});

it('drops a client that stops reading as soon as one event is left unsent', async () => {
  const events = new Subject<MessageEvent>();
  const app = await createTestApp({
    override: (builder) =>
      builder
        .overrideProvider(EventsService)
        .useValue({ stream: () => events.asObservable() }),
  });
  const warn = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => {});
  try {
    const stream = await openEventStream(app);
    stream.on('error', () => {});
    await once(stream, 'data');
    stream.pause();
    const closed = new Promise((resolve) => stream.once('close', resolve));
    const data = 'x'.repeat(1_000_000);
    // Socket buffers swallow the first events; the first one that cannot be sent trips the limit.
    for (let sent = 0; sent < 100 && warn.mock.calls.length === 0; sent++) {
      events.next({ data });
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(warn).toHaveBeenCalledTimes(1);
    const queued = /: (\d+) character/.exec(
      String(warn.mock.calls[0]?.[0]),
    )?.[1];
    expect(Number(queued)).toBeLessThan(3_000_000);
    stream.resume();
    await closed;
  } finally {
    warn.mockRestore();
    await app.close();
  }
});
