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
describe('older receipts', () => {
  const at = (minutes: number) =>
    new Date(
      Date.parse('2026-10-20T12:00:00Z') - minutes * 60000,
    ).toISOString();
  const rows = Array.from({ length: 130 }, (_, i) => ({
    ...row(`p${String(i).padStart(3, '0')}`, 'received'),
    sentAt: at(i),
  }));
  /** A client over 130 payments whose older-page reads can be held, failed or answered late. */
  function paged() {
    const stream = new FakeEventSource();
    const older = {
      hold: null as Promise<void> | null,
      fail: false,
      reads: 0,
      repeat: [] as unknown[],
      refreshes: 0,
      stuck: false,
    };
    const client = new PaymentsClient(
      'https://api.example.com',
      async (url) => {
        const { pathname, searchParams } = new URL(String(url));
        if (pathname === '/payments') {
          const before = searchParams.get('before');
          const cursor = before ? decodeTestCursor(before) : null;
          // A stuck server ignores `before` and answers the first page again.
          const index =
            cursor && !older.stuck
              ? rows.findIndex((r) => r.id === cursor.id) + 1
              : 0;
          const page = rows.slice(
            index,
            index + Number(searchParams.get('limit')),
          );
          if (before) {
            older.reads++;
            await older.hold;
            if (older.stuck && older.reads > 50) throw new Error('runaway');
            if (older.fail) return new Response('{}', { status: 503 });
          }
          return Response.json(before ? [...page, ...older.repeat] : page);
        }
        if (pathname === '/stats/daily') {
          older.refreshes++;
          return Response.json([]);
        }
        return Response.json({});
      },
      () => stream,
    );
    const data = () => {
      const current = client.getSnapshot().data;
      if (!current) throw new Error('No data yet');
      return current;
    };
    const showAll = async () => {
      for (let page = 0; page < 4; page++) client.showMoreReceipts();
    };
    return { client, stream, older, data, showAll };
  }
  it('keeps a newer stage when an older page arrives late', async () => {
    const s = paged();
    const stop = s.client.subscribe(() => {});
    s.stream.open();
    await vi.waitFor(() => expect(s.client.getSnapshot().status).toBe('live'));
    await s.showAll();
    s.client.showMoreReceipts();
    await vi.waitFor(() => expect(s.data().receipts).toHaveLength(120));
    let release = () => {};
    s.older.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.older.repeat = [rows[110]];
    s.client.showMoreReceipts();
    await vi.waitFor(() => expect(s.older.reads).toBe(2));
    const refreshes = s.older.refreshes;
    s.stream.send({ ...rows[110], stage: 'settled' });
    // The event's own refresh finishes first, so the page is the late one.
    await vi.waitFor(() => expect(s.older.refreshes).toBe(refreshes + 1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await vi.waitFor(() => expect(s.data().receipts).toHaveLength(130));
    expect(s.data().receipts.find((p) => p.id === 'p110')?.stage).toBe(
      'settled',
    );
    stop();
  });
  /** Counts of the shown receipts at every update, to catch a collapse that a later update hides. */
  function watchCounts(s: ReturnType<typeof paged>) {
    const counts: number[] = [];
    const stop = s.client.subscribe(() => {
      const data = s.client.getSnapshot().data;
      if (data) counts.push(data.receipts.length);
    });
    return { counts, stop };
  }
  it('keeps the visible receipts when the stream reopens', async () => {
    const s = paged();
    const { counts, stop } = watchCounts(s);
    s.stream.open();
    await vi.waitFor(() => expect(s.client.getSnapshot().status).toBe('live'));
    for (let page = 0; page < 2; page++) s.client.showMoreReceipts();
    expect(s.data().receipts).toHaveLength(60);
    const before = counts.length;
    s.stream.disconnect();
    s.stream.open();
    await vi.waitFor(() => expect(counts.length).toBeGreaterThan(before));
    expect(Math.min(...counts.slice(before))).toBe(60);
    expect(s.data().receipts).toHaveLength(60);
    stop();
  });
  it('refreshes older receipts after the stream reopens', async () => {
    const s = paged();
    const { counts, stop } = watchCounts(s);
    s.stream.open();
    await vi.waitFor(() => expect(s.client.getSnapshot().status).toBe('live'));
    await s.showAll();
    s.client.showMoreReceipts();
    await vi.waitFor(() => expect(s.data().receipts).toHaveLength(120));
    const stageOf = () => s.data().receipts.find((p) => p.id === 'p110')?.stage;
    expect(stageOf()).toBe('received');
    const before = counts.length;
    const reads = s.older.reads;
    const changed = rows.find((r) => r.id === 'p110');
    if (!changed) throw new Error('No row p110');
    changed.stage = 'settled';
    try {
      s.stream.disconnect();
      s.stream.open();
      await vi.waitFor(() => expect(stageOf()).toBe('settled'));
    } finally {
      changed.stage = 'received';
    }
    expect(s.older.reads).toBeGreaterThan(reads);
    expect(Math.min(...counts.slice(before))).toBe(120);
    expect(s.data().olderReceipts).toBe('more');
    s.client.showMoreReceipts();
    await vi.waitFor(() => expect(s.data().receipts).toHaveLength(130));
    stop();
  });
  it('keeps the shown receipts when refreshing older ones fails', async () => {
    const s = paged();
    const { counts, stop } = watchCounts(s);
    s.stream.open();
    await vi.waitFor(() => expect(s.client.getSnapshot().status).toBe('live'));
    await s.showAll();
    s.client.showMoreReceipts();
    await vi.waitFor(() => expect(s.data().receipts).toHaveLength(120));
    const before = counts.length;
    s.older.fail = true;
    s.stream.disconnect();
    s.stream.open();
    await vi.waitFor(() => expect(s.data().olderFailed).toBe(true));
    expect(Math.min(...counts.slice(before))).toBe(120);
    expect(s.data().olderReceipts).toBe('more');
    stop();
  });
  /** Opens the stream, shows 120 receipts, then reopens with older reads held until `release`. */
  async function reopenHeld(s: ReturnType<typeof paged>) {
    s.stream.open();
    await vi.waitFor(() => expect(s.client.getSnapshot().status).toBe('live'));
    await s.showAll();
    s.client.showMoreReceipts();
    await vi.waitFor(() => expect(s.data().receipts).toHaveLength(120));
    let release = () => {};
    s.older.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reads = s.older.reads;
    s.stream.disconnect();
    return { release, reads };
  }
  it('keeps a receipt that left the live list while older ones were re-read', async () => {
    const s = paged();
    const stop = s.client.subscribe(() => {});
    const { release, reads } = await reopenHeld(s);
    s.stream.open();
    await vi.waitFor(() => expect(s.older.reads).toBeGreaterThan(reads));
    // A new payment pushes the oldest live row, p099, into the older rows.
    s.stream.send({
      ...row('fresh', 'received'),
      sentAt: at(-5),
    });
    await vi.waitFor(() =>
      expect(s.data().payments.some((p) => p.id === 'fresh')).toBe(true),
    );
    release();
    await vi.waitFor(() => expect(s.data().olderReceipts).not.toBe('loading'));
    expect(s.data().receipts.map((p) => p.id)).toContain('p099');
    expect(s.data().receipts).toHaveLength(120);
    stop();
  });
  it('stops re-reading when a page adds nothing new', async () => {
    const s = paged();
    const stop = s.client.subscribe(() => {});
    s.stream.open();
    await vi.waitFor(() => expect(s.client.getSnapshot().status).toBe('live'));
    await s.showAll();
    s.client.showMoreReceipts();
    await vi.waitFor(() => expect(s.data().receipts).toHaveLength(120));
    const reads = s.older.reads;
    s.older.stuck = true;
    s.stream.disconnect();
    s.stream.open();
    await vi.waitFor(() => expect(s.older.reads).toBeGreaterThan(reads));
    await vi.waitFor(() => expect(s.data().olderReceipts).not.toBe('loading'));
    expect(s.older.reads - reads).toBeLessThanOrEqual(2);
    expect(s.data().olderFailed).toBe(false);
    expect(s.data().receipts).toHaveLength(120);
    stop();
  });
  it('does not lose rows when Show more is pressed during a refresh', async () => {
    const s = paged();
    const stop = s.client.subscribe(() => {});
    const { release, reads } = await reopenHeld(s);
    s.stream.open();
    // Before the re-read starts, the reopen has cleared the loading state.
    s.client.showMoreReceipts();
    await vi.waitFor(() => expect(s.older.reads).toBeGreaterThan(reads));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await vi.waitFor(() => expect(s.data().olderReceipts).not.toBe('loading'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.data().receipts).toHaveLength(120);
    expect(s.data().olderReceipts).toBe('more');
    s.client.showMoreReceipts();
    await vi.waitFor(() => expect(s.data().receipts).toHaveLength(130));
    stop();
  });
  it('says when older receipts could not load', async () => {
    const s = paged();
    const stop = s.client.subscribe(() => {});
    s.stream.open();
    await vi.waitFor(() => expect(s.client.getSnapshot().status).toBe('live'));
    await s.showAll();
    s.older.fail = true;
    s.client.showMoreReceipts();
    await vi.waitFor(() => expect(s.data().olderFailed).toBe(true));
    expect(s.data().olderReceipts).toBe('more');
    expect(s.data().receipts).toHaveLength(100);
    s.older.fail = false;
    s.client.showMoreReceipts();
    await vi.waitFor(() => expect(s.data().receipts).toHaveLength(120));
    expect(s.data().olderFailed).toBe(false);
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
