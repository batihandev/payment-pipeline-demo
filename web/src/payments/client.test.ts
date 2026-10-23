import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HEALTH_EVERY_MS,
  PaymentsClient,
  STREAM_REOPEN_MS,
  type EventStream,
} from './client';

class FakeEventSource implements EventStream {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close() {}
  open() {
    this.onopen?.();
  }
  disconnect() {
    this.onerror?.();
  }
  send(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
const row = (id: string, stage = 'received') => ({
  id,
  orderId: `order-${id}`,
  stage,
  amount: '14000731',
  confirmations: 0,
  provider: 'chain',
  blockNumber: '91',
  final: false,
  sentAt: '2026-10-20T12:00:00Z',
  receivedAt: null,
  order: { id: `order-${id}`, item: 'Gold rubber duck', price: '14000000' },
  explorerUrl: 'https://example.com/tx/123',
  noteKinds: ['payment_reorg'],
});
function server() {
  let payments = [row('old')];
  let settledCount = 0;
  let available = true;
  let healthAvailable = true;
  const requested: string[] = [];
  let hold: Promise<void> = Promise.resolve();
  const stream = new FakeEventSource();
  let streamsOpened = 0;
  const client = new PaymentsClient(
    'https://api.example.com',
    async function (this: unknown, url) {
      if (this !== undefined) throw new TypeError('Illegal invocation');
      const snapshot = structuredClone({
        '/payments?limit=100': payments,
        '/stats': {
          settledCount,
          averageTimeToSettleMs: null,
          duplicatesSkipped: 0,
          failuresRecovered: 0,
        },
        '/stats/daily': [],
        '/health': {
          confirmations: 7,
          head: '100',
          cursor: '99',
          lag: '1',
          openGaps: 0,
          queueDepth: {},
          cooldowns: {},
          balances: {},
        },
      });
      const path = new URL(String(url)).pathname;
      requested.push(path);
      await hold;
      if (!available) throw new Error('offline');
      if (path === '/health' && !healthAvailable)
        return new Response('{}', { status: 503 });
      return new Response(
        JSON.stringify(
          snapshot[
            (new URL(String(url)).pathname +
              new URL(String(url)).search) as keyof typeof snapshot
          ],
        ),
      );
    },
    () => {
      streamsOpened++;
      return stream;
    },
  );
  return {
    client,
    stream,
    requested,
    streamsOpened: () => streamsOpened,
    healthOffline: () => {
      healthAvailable = false;
    },
    replace: () => {
      payments = [row('new', 'settled')];
      settledCount = 1;
    },
    offline: () => {
      available = false;
    },
    hold: (promise: Promise<void>) => {
      hold = promise;
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
});
describe('live payments', () => {
  it('replaces missed rows and statistics with a fresh load after reconnect', async () => {
    const s = server();
    const stop = s.client.subscribe(() => {});
    s.stream.open();
    await vi.waitFor(() =>
      expect(s.client.getSnapshot().data?.payments[0]?.id).toBe('old'),
    );
    s.stream.disconnect();
    s.replace();
    s.stream.open();
    await vi.waitFor(() =>
      expect(s.client.getSnapshot().data?.payments.map((p) => p.id)).toEqual([
        'new',
      ]),
    );
    expect(s.client.getSnapshot().data?.stats.settledCount).toBe(1);
    expect(s.client.getSnapshot().data?.daily).toEqual([]);
    stop();
  });
  it('buffers events during reconnect and applies them after the snapshot without losing order details', async () => {
    const s = server();
    const stop = s.client.subscribe(() => {});
    s.stream.open();
    await vi.waitFor(() => expect(s.client.getSnapshot().status).toBe('live'));
    s.stream.disconnect();
    let release = () => {};
    s.hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    s.stream.open();
    s.stream.send({
      ...row('old', 'confirming'),
      order: undefined,
      explorerUrl: undefined,
      confirmations: 3,
    });
    expect(s.client.getSnapshot().status).toBe('live');
    expect(s.client.getSnapshot().data?.payments[0]?.id).toBe('old');
    release();
    await vi.waitFor(() =>
      expect(s.client.getSnapshot().data?.payments[0]?.confirmations).toBe(3),
    );
    expect(s.client.getSnapshot().data?.payments[0]?.order?.item).toBe(
      'Gold rubber duck',
    );
    expect(s.client.getSnapshot().data?.payments[0]?.explorerUrl).toBe(
      'https://example.com/tx/123',
    );
    stop();
  });
  it('keeps note kinds when a payment arrives on the stream', async () => {
    const s = server();
    const stop = s.client.subscribe(() => {});
    s.stream.open();
    await vi.waitFor(() => expect(s.client.getSnapshot().status).toBe('live'));
    s.stream.send({ ...row('old', 'settled'), noteKinds: undefined });
    expect(
      s.client.getSnapshot().data?.payments.find((p) => p.id === 'old'),
    ).toMatchObject({ stage: 'settled', noteKinds: ['payment_reorg'] });
    await vi.waitFor(() => {
      s.stream.send({ ...row('fresh'), noteKinds: undefined });
      expect(
        s.client.getSnapshot().data?.payments.find((p) => p.id === 'fresh')
          ?.noteKinds,
      ).toEqual([]);
    });
    stop();
  });
  it('does not request /incidents', async () => {
    const s = server();
    const stop = s.client.subscribe(() => {});
    s.stream.open();
    await vi.waitFor(() => expect(s.client.getSnapshot().status).toBe('live'));
    expect(s.requested).not.toContain('/incidents');
    expect(s.client.getSnapshot().data).not.toHaveProperty('incidents');
    stop();
  });
  it('reads /health on load and on its timer, not on every event', async () => {
    vi.useFakeTimers();
    const s = server();
    const stop = s.client.subscribe(() => {});
    s.stream.open();
    await vi.waitFor(() => expect(s.client.getSnapshot().status).toBe('live'));
    await vi.waitFor(() =>
      expect(s.client.getSnapshot().data?.health?.head).toBe('100'),
    );
    const health = () => s.requested.filter((p) => p === '/health').length;
    expect(health()).toBe(1);
    for (let index = 0; index < 5; index++) {
      s.stream.send(row(`event-${index}`, 'received'));
      await vi.waitFor(() =>
        expect(
          s.requested.filter((p) => p === '/payments').length,
        ).toBeGreaterThan(index + 1),
      );
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(health()).toBe(1);
    await vi.advanceTimersByTimeAsync(HEALTH_EVERY_MS);
    expect(health()).toBe(2);
    stop();
  });
  it('stays live with checkout data when /health fails', async () => {
    const s = server();
    s.healthOffline();
    const stop = s.client.subscribe(() => {});
    s.stream.open();
    await vi.waitFor(() => expect(s.client.getSnapshot().status).toBe('live'));
    expect(s.client.getSnapshot().data?.payments[0]?.id).toBe('old');
    expect(s.client.getSnapshot().data?.health).toBeNull();
    stop();
  });
  it('goes offline only when nothing has loaded', async () => {
    const s = server();
    s.offline();
    const stop = s.client.subscribe(() => {});
    await vi.waitFor(() =>
      expect(s.client.getSnapshot().status).toBe('offline'),
    );
    expect(s.client.getSnapshot().data).toBeNull();
    stop();
  });
  it('loads over polling when the stream never opens', async () => {
    const s = server();
    const stop = s.client.subscribe(() => {});
    s.stream.disconnect();
    await vi.waitFor(() => expect(s.client.getSnapshot().status).toBe('live'));
    expect(s.client.getSnapshot().data?.payments[0]?.id).toBe('old');
    stop();
  });
  it('keeps the data when the stream errors', async () => {
    const s = server();
    const stop = s.client.subscribe(() => {});
    s.stream.open();
    await vi.waitFor(() => expect(s.client.getSnapshot().status).toBe('live'));
    const before = s.client.getSnapshot();
    s.stream.disconnect();
    expect(s.client.getSnapshot()).toBe(before);
    stop();
  });
  it('reopens the stream after 30 s', async () => {
    vi.useFakeTimers();
    const s = server();
    const stop = s.client.subscribe(() => {});
    expect(s.streamsOpened()).toBe(1);
    s.stream.disconnect();
    await vi.advanceTimersByTimeAsync(STREAM_REOPEN_MS - 1);
    expect(s.streamsOpened()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.streamsOpened()).toBe(2);
    stop();
    s.stream.disconnect();
    await vi.advanceTimersByTimeAsync(STREAM_REOPEN_MS * 2);
    expect(s.streamsOpened()).toBe(2);
  });
  it('keeps the data when a refresh is refused', async () => {
    vi.useFakeTimers();
    const s = server();
    const stop = s.client.subscribe(() => {});
    s.stream.open();
    await vi.waitFor(() => expect(s.client.getSnapshot().status).toBe('live'));
    s.offline();
    const requests = s.requested.length;
    await vi.advanceTimersByTimeAsync(15000);
    expect(s.requested.length).toBeGreaterThan(requests);
    expect(s.client.getSnapshot().status).toBe('live');
    expect(s.client.getSnapshot().data?.payments[0]?.id).toBe('old');
    stop();
  });
});
