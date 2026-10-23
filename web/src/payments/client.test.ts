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
  private named = new Map<string, (event: { data: string }) => void>();
  addEventListener(type: string, listener: (event: { data: string }) => void) {
    this.named.set(type, listener);
  }
  emit(type: string, value: unknown) {
    this.named.get(type)?.({ data: JSON.stringify(value) });
  }
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
describe('order updates', () => {
  it('passes order and queue events from the stream to order listeners', () => {
    const s = server();
    const stop = s.client.subscribe(() => {});
    const updates: unknown[] = [];
    const unlisten = s.client.onOrderUpdate((update) => updates.push(update));
    s.stream.emit('order', { type: 'order', id: 'o1', closed: true });
    s.stream.emit('queue', { type: 'queue', waiting: ['o2', 'o1'] });
    s.stream.emit('queue', { type: 'queue', waiting: 'o1' });
    unlisten();
    s.stream.emit('order', { type: 'order', id: 'o3', closed: true });
    expect(updates).toEqual([
      { type: 'order', id: 'o1', closed: true },
      { type: 'queue', waiting: ['o2', 'o1'] },
    ]);
    stop();
  });
  it('tells order listeners each time the stream opens', () => {
    const s = server();
    const stop = s.client.subscribe(() => {});
    const updates: unknown[] = [];
    s.client.onOrderUpdate((update) => updates.push(update));
    s.stream.open();
    s.stream.disconnect();
    s.stream.open();
    expect(updates).toEqual([{ type: 'opened' }, { type: 'opened' }]);
    stop();
  });
});
describe('test purchases', () => {
  it('posts the chosen rail and returns the answer with its retry hint', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = new PaymentsClient(
      'https://api.example.com/',
      async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ error: 'card_unavailable' }), {
          status: 503,
          headers: { 'retry-after': '5' },
        });
      },
      () => new FakeEventSource(),
    );
    const answer = await client.purchase('card');
    expect(calls).toEqual([
      {
        url: 'https://api.example.com/test-purchases',
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rail: 'card' }),
        },
      },
    ]);
    expect(answer).toEqual({
      ok: false,
      status: 503,
      retryAfter: '5',
      body: { error: 'card_unavailable' },
    });
  });
});
describe('receipts', () => {
  it('loads older receipts with Show more', async () => {
    const at = (minutes: number) =>
      new Date(
        Date.parse('2026-10-20T12:00:00Z') - minutes * 60000,
      ).toISOString();
    const rows = Array.from({ length: 130 }, (_, i) => ({
      ...row(`p${String(i).padStart(3, '0')}`, 'settled'),
      sentAt: at(i),
    }));
    const requested: string[] = [];
    const stream = new FakeEventSource();
    const client = new PaymentsClient(
      'https://api.example.com',
      async (url) => {
        const { pathname, searchParams } = new URL(String(url));
        requested.push(pathname + new URL(String(url)).search);
        if (pathname === '/payments') {
          const before = searchParams.get('before');
          const cursor = before ? decodeTestCursor(before) : null;
          const index = cursor
            ? rows.findIndex((r) => r.id === cursor.id) + 1
            : 0;
          return Response.json(
            rows.slice(index, index + Number(searchParams.get('limit'))),
          );
        }
        if (pathname === '/stats/daily') return Response.json([]);
        return Response.json({});
      },
      () => stream,
    );
    const snapshot = () => {
      const data = client.getSnapshot().data;
      if (!data) throw new Error('No data yet');
      return data;
    };
    const ids = () => snapshot().receipts.map((p) => p.id);
    const stop = client.subscribe(() => {});
    stream.open();
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe('live'));
    expect(ids()).toEqual(rows.slice(0, 20).map((r) => r.id));
    expect(snapshot().olderReceipts).toBe('more');

    for (let page = 0; page < 4; page++) client.showMoreReceipts();
    expect(ids()).toEqual(rows.slice(0, 100).map((r) => r.id));
    expect(requested.some((path) => path.includes('before='))).toBe(false);

    client.showMoreReceipts();
    expect(snapshot().olderReceipts).toBe('loading');
    await vi.waitFor(() => expect(ids()).toHaveLength(120));
    expect(ids()).toEqual(rows.slice(0, 120).map((r) => r.id));
    expect(decodeTestCursor(beforeOf(requested.at(-1) ?? ''))).toEqual({
      at: rows[99]?.sentAt,
      id: rows[99]?.id,
    });
    expect(snapshot().olderReceipts).toBe('more');

    client.showMoreReceipts();
    await vi.waitFor(() => expect(snapshot().olderReceipts).toBe('none'));
    expect(ids()).toEqual(rows.map((r) => r.id));

    stream.send({ ...row('fresh', 'received'), sentAt: at(-1) });
    expect(ids()[0]).toBe('fresh');
    expect(ids()).toHaveLength(131);
    stream.send({ ...rows[125], stage: 'notified' });
    await vi.waitFor(() =>
      expect(snapshot().receipts.find((p) => p.id === 'p125')?.stage).toBe(
        'notified',
      ),
    );
    expect(ids()[0]).toBe('fresh');
    stop();
  });
});
describe('receipts when every payment is live', () => {
  it('reads no older page when the live list holds every payment', async () => {
    const rows = Array.from({ length: 45 }, (_, i) => ({
      ...row(`p${String(i).padStart(3, '0')}`, 'settled'),
      sentAt: new Date(
        Date.parse('2026-10-20T12:00:00Z') - i * 60000,
      ).toISOString(),
    }));
    const requested: string[] = [];
    const stream = new FakeEventSource();
    const client = new PaymentsClient(
      'https://api.example.com',
      async (url) => {
        const { pathname, search } = new URL(String(url));
        requested.push(pathname + search);
        if (pathname === '/payments') return Response.json(rows);
        if (pathname === '/stats/daily') return Response.json([]);
        return Response.json({});
      },
      () => stream,
    );
    const stop = client.subscribe(() => {});
    stream.open();
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe('live'));
    client.showMoreReceipts();
    expect(client.getSnapshot().data?.olderReceipts).toBe('more');
    client.showMoreReceipts();
    expect(client.getSnapshot().data?.receipts).toHaveLength(45);
    expect(client.getSnapshot().data?.olderReceipts).toBe('none');
    expect(requested.filter((path) => path.includes('before='))).toEqual([]);
    stop();
  });
});
function beforeOf(path: string): string {
  return (
    new URL(path, 'https://api.example.com').searchParams.get('before') ?? ''
  );
}
function decodeTestCursor(value: string): { at: string; id: string } {
  return JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/'))) as {
    at: string;
    id: string;
  };
}
