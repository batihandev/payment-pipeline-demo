import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HEALTH_EVERY_MS,
  PaymentsClient,
  STREAM_REOPEN_MS,
  type EventStream,
} from './client';
import { health, order, payment } from './test-fixtures';
import type { Payment, Stats } from './types';

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
const row = (id: string, stage: Payment['stage'] = 'received') =>
  payment({
    id,
    orderId: `order-${id}`,
    stage,
    amount: '14000731',
    confirmations: 0,
    blockNumber: '91',
    sentAt: '2026-10-20T12:00:00Z',
    receivedAt: null,
    order: order({
      id: `order-${id}`,
      item: 'Gold rubber duck',
      price: '14000000',
    }),
    explorerUrl: 'https://example.com/tx/123',
    noteKinds: ['payment_reorg'],
  });
const todayStats = (settledCount = 0): Stats => ({
  settledCount,
  averageTimeToSettleMs: null,
  duplicatesSkipped: 0,
  failuresRecovered: 0,
});
/** The URL a fetch was called with, whatever form it took. */
const href = (input: RequestInfo | URL) =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

function server() {
  let payments = [row('old')];
  let settledCount = 0;
  let available = true;
  let healthAvailable = true;
  const replies = new Map<string, unknown>();
  const requested: string[] = [];
  let hold: Promise<void> = Promise.resolve();
  const stream = new FakeEventSource();
  let streamsOpened = 0;
  const client = new PaymentsClient(
    'https://api.example.com',
    async function (this: unknown, url) {
      if (this !== undefined) throw new TypeError('Illegal invocation');
      const snapshot = structuredClone({
        '/payments?limit=101': payments,
        '/stats': todayStats(settledCount),
        '/stats/daily': [],
        '/health': health({
          confirmations: 7,
          cursor: '99',
          lag: '1',
          queueDepth: {},
          cooldowns: {},
        }),
      });
      const path = new URL(href(url)).pathname;
      requested.push(path);
      await hold;
      if (!available) throw new Error('offline');
      if (path === '/health' && !healthAvailable)
        return new Response('{}', { status: 503 });
      const key = new URL(href(url)).pathname + new URL(href(url)).search;
      return new Response(
        JSON.stringify(
          replies.has(key)
            ? replies.get(key)
            : snapshot[key as keyof typeof snapshot],
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
    /** Answers `path` with `body` from now on. */
    reply: (path: string, body: unknown) => {
      replies.set(path, body);
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
    await vi.waitFor(() => {
      expect(s.client.getSnapshot().data?.payments[0]?.id).toBe('old');
    });
    s.stream.disconnect();
    s.replace();
    s.stream.open();
    await vi.waitFor(() => {
      expect(s.client.getSnapshot().data?.payments.map((p) => p.id)).toEqual([
        'new',
      ]);
    });
    expect(s.client.getSnapshot().data?.stats.settledCount).toBe(1);
    expect(s.client.getSnapshot().data?.daily).toEqual([]);
    stop();
  });
  it('buffers events during reconnect and applies them after the snapshot without losing order details', async () => {
    const s = server();
    const stop = s.client.subscribe(() => {});
    s.stream.open();
    await vi.waitFor(() => {
      expect(s.client.getSnapshot().status).toBe('live');
    });
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
    await vi.waitFor(() => {
      expect(s.client.getSnapshot().data?.payments[0]?.confirmations).toBe(3);
    });
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
    await vi.waitFor(() => {
      expect(s.client.getSnapshot().status).toBe('live');
    });
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
    await vi.waitFor(() => {
      expect(s.client.getSnapshot().status).toBe('live');
    });
    expect(s.requested).not.toContain('/incidents');
    expect(s.client.getSnapshot().data).not.toHaveProperty('incidents');
    stop();
  });
  it('reads /health on load and on its timer, not on every event', async () => {
    vi.useFakeTimers();
    const s = server();
    const stop = s.client.subscribe(() => {});
    s.stream.open();
    await vi.waitFor(() => {
      expect(s.client.getSnapshot().status).toBe('live');
    });
    await vi.waitFor(() => {
      expect(s.client.getSnapshot().data?.health?.head).toBe('100');
    });
    const health = () => s.requested.filter((p) => p === '/health').length;
    expect(health()).toBe(1);
    for (let index = 0; index < 5; index++) {
      s.stream.send(row(`event-${index}`, 'received'));
      await vi.waitFor(() => {
        expect(
          s.requested.filter((p) => p === '/payments').length,
        ).toBeGreaterThan(index + 1);
      });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(health()).toBe(1);
    await vi.advanceTimersByTimeAsync(HEALTH_EVERY_MS);
    expect(health()).toBe(2);
    stop();
  });
  it('treats a malformed response as offline', async () => {
    const s = server();
    s.reply('/stats', { settledCount: 'many' });
    const stop = s.client.subscribe(() => {});
    await vi.waitFor(() => {
      expect(s.client.getSnapshot().status).toBe('offline');
    });
    expect(s.client.getSnapshot().data).toBeNull();
    stop();
  });
  it('keeps the last health when /health answers a malformed body', async () => {
    vi.useFakeTimers();
    const s = server();
    const stop = s.client.subscribe(() => {});
    await vi.waitFor(() => {
      expect(s.client.getSnapshot().data?.health?.head).toBe('100');
    });
    s.reply('/health', { head: 7 });
    const reads = s.requested.filter((p) => p === '/health').length;
    await vi.advanceTimersByTimeAsync(HEALTH_EVERY_MS);
    expect(s.requested.filter((p) => p === '/health')).toHaveLength(reads + 1);
    expect(s.client.getSnapshot().data?.health?.head).toBe('100');
    stop();
  });
  it('skips a malformed payment event', async () => {
    const s = server();
    const stop = s.client.subscribe(() => {});
    await vi.waitFor(() => {
      expect(s.client.getSnapshot().status).toBe('live');
    });
    s.stream.send({ ...row('old', 'settled'), stage: 'lost', version: 9 });
    expect(s.client.getSnapshot().data?.payments[0]?.stage).toBe('received');
    stop();
  });
  it('stays live with checkout data when /health fails', async () => {
    const s = server();
    s.healthOffline();
    const stop = s.client.subscribe(() => {});
    s.stream.open();
    await vi.waitFor(() => {
      expect(s.client.getSnapshot().status).toBe('live');
    });
    expect(s.client.getSnapshot().data?.payments[0]?.id).toBe('old');
    expect(s.client.getSnapshot().data?.health).toBeNull();
    stop();
  });
  it('goes offline only when nothing has loaded', async () => {
    const s = server();
    s.offline();
    const stop = s.client.subscribe(() => {});
    await vi.waitFor(() => {
      expect(s.client.getSnapshot().status).toBe('offline');
    });
    expect(s.client.getSnapshot().data).toBeNull();
    stop();
  });
  it('loads over polling when the stream never opens', async () => {
    const s = server();
    const stop = s.client.subscribe(() => {});
    s.stream.disconnect();
    await vi.waitFor(() => {
      expect(s.client.getSnapshot().status).toBe('live');
    });
    expect(s.client.getSnapshot().data?.payments[0]?.id).toBe('old');
    stop();
  });
  it('keeps the data when the stream errors', async () => {
    const s = server();
    const stop = s.client.subscribe(() => {});
    s.stream.open();
    await vi.waitFor(() => {
      expect(s.client.getSnapshot().status).toBe('live');
    });
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
    await vi.waitFor(() => {
      expect(s.client.getSnapshot().status).toBe('live');
    });
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
      (url, init) => {
        calls.push({ url: href(url), init });
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'card_unavailable' }), {
            status: 503,
            headers: { 'retry-after': '5' },
          }),
        );
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
describe('receipt window', () => {
  const at = (minutes: number) =>
    new Date(
      Date.parse('2026-10-20T12:00:00Z') - minutes * 60000,
    ).toISOString();
  /** A client over `count` payments whose `/payments` reads can be held or failed. */
  function windowed(count = 250) {
    const rows = Array.from({ length: count }, (_, i) => ({
      ...row(`p${String(i).padStart(3, '0')}`, 'received'),
      sentAt: at(i),
    }));
    const stream = new FakeEventSource();
    const reads: string[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const server = {
      hold: null as Promise<void> | null,
      fail: false,
    };
    const client = new PaymentsClient(
      'https://api.example.com',
      async (url, init) => {
        const { pathname, search, searchParams } = new URL(href(url));
        if (pathname === '/payments') {
          reads.push(search);
          signals.push(init?.signal ?? undefined);
          await server.hold;
          if (server.fail) return new Response('{}', { status: 503 });
          return Response.json(
            rows.slice(0, Number(searchParams.get('limit'))),
          );
        }
        if (pathname === '/stats/daily') return Response.json([]);
        if (pathname === '/stats') return Response.json(todayStats());
        return Response.json(health());
      },
      () => stream,
    );
    const data = () => {
      const current = client.getSnapshot().data;
      if (!current) throw new Error('No data yet');
      return current;
    };
    const holdReads = () => {
      let release = () => {};
      server.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        server.hold = null;
        release();
      };
    };
    const showMore = async () => {
      const shown = data().receipts.length;
      client.showMoreReceipts();
      await vi.waitFor(() => {
        expect(data().receipts.length).toBeGreaterThan(shown);
      });
    };
    const load = async () => {
      stream.open();
      await vi.waitFor(() => {
        expect(client.getSnapshot().status).toBe('live');
      });
    };
    return {
      client,
      stream,
      rows,
      reads,
      signals,
      server,
      data,
      holdReads,
      showMore,
      load,
    };
  }
  /** Counts of the shown receipts at every update, to catch a collapse that a later update hides. */
  function watchCounts(s: ReturnType<typeof windowed>) {
    const counts: number[] = [];
    const stop = s.client.subscribe(() => {
      const data = s.client.getSnapshot().data;
      if (data) counts.push(data.receipts.length);
    });
    return { counts, stop };
  }
  it('hides Show more when exactly the window size exists', async () => {
    const s = windowed(120);
    const stop = s.client.subscribe(() => {});
    await s.load();
    for (let shown = 20; shown < 120; shown += 20) {
      expect(s.data().olderReceipts).toBe('more');
      await s.showMore();
    }
    await vi.waitFor(() => {
      expect(s.data().olderReceipts).not.toBe('loading');
    });
    expect(s.data().receipts).toHaveLength(120);
    expect(s.data().olderReceipts).toBe('none');
    stop();
  });
  it('shows the newest 20 and adds 20 with each Show more', async () => {
    const s = windowed();
    const stop = s.client.subscribe(() => {});
    await s.load();
    const ids = () => s.data().receipts.map((p) => p.id);
    expect(ids()).toEqual(s.rows.slice(0, 20).map((r) => r.id));
    expect(s.data().olderReceipts).toBe('more');
    for (const size of [40, 60, 80, 100, 120, 140]) {
      await s.showMore();
      expect(ids()).toEqual(s.rows.slice(0, size).map((r) => r.id));
    }
    // The pipeline counts still cover the newest 100.
    expect(s.data().payments).toHaveLength(100);
    s.stream.send({ ...row('fresh', 'received'), sentAt: at(-1) });
    expect(ids()[0]).toBe('fresh');
    expect(ids()).toHaveLength(140);
    expect(s.data().payments).toHaveLength(100);
    stop();
  });
  it('reads the whole window in one request', async () => {
    const s = windowed();
    const stop = s.client.subscribe(() => {});
    await s.load();
    for (let i = 0; i < 4; i++) await s.showMore();
    const reads = s.reads.length;
    await s.showMore();
    expect(s.data().receipts).toHaveLength(120);
    expect(s.reads.slice(reads)).toEqual(['?limit=121']);
    expect(s.reads.every((search) => !search.includes('before='))).toBe(true);
    stop();
  });
  it('keeps the window size across a stream reopen', async () => {
    const s = windowed();
    const { counts, stop } = watchCounts(s);
    await s.load();
    for (let i = 0; i < 5; i++) await s.showMore();
    expect(s.data().receipts).toHaveLength(120);
    const updates = counts.length;
    const reads = s.reads.length;
    const changed = s.rows[110];
    if (!changed) throw new Error('No row p110');
    changed.stage = 'settled';
    s.stream.disconnect();
    s.stream.open();
    await vi.waitFor(() => {
      expect(s.data().receipts.find((p) => p.id === 'p110')?.stage).toBe(
        'settled',
      );
    });
    expect(s.reads.slice(reads)).toEqual(['?limit=121']);
    expect(Math.min(...counts.slice(updates))).toBe(120);
    expect(s.data().receipts).toHaveLength(120);
    expect(s.data().olderReceipts).toBe('more');
    stop();
  });
  /** Lets the reads already started finish. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  it('shows a reorged payment moving back to sent', async () => {
    const s = windowed();
    const confirming = {
      ...s.rows[0],
      stage: 'confirming',
      confirmations: 2,
      receivedAt: at(0),
      noteKinds: [],
      version: 3,
    };
    Object.assign(s.rows[0] ?? {}, confirming);
    const stop = s.client.subscribe(() => {});
    await s.load();
    expect(s.data().receipts[0]).toMatchObject({ stage: 'confirming' });
    const reorged = {
      ...confirming,
      stage: 'sent',
      blockNumber: null,
      confirmations: 0,
      receivedAt: null,
      version: 4,
    };
    Object.assign(s.rows[0] ?? {}, reorged, { noteKinds: ['payment_reorg'] });
    s.stream.send({ ...reorged, noteKinds: undefined });
    expect(s.data().receipts[0]).toMatchObject({
      stage: 'sent',
      blockNumber: null,
      confirmations: 0,
      receivedAt: null,
    });
    await vi.waitFor(() => {
      expect(s.data().receipts[0]?.noteKinds).toEqual(['payment_reorg']);
    });
    expect(s.data().receipts[0]).toMatchObject({ stage: 'sent', version: 4 });
    stop();
  });
  it('takes a read with a higher version over a held row', async () => {
    const s = windowed();
    const stop = s.client.subscribe(() => {});
    await s.load();
    s.stream.send({ ...s.rows[5], stage: 'confirming', version: 2 });
    await settle();
    expect(s.data().receipts[5]).toMatchObject({ stage: 'confirming' });
    Object.assign(s.rows[5] ?? {}, {
      stage: 'sent',
      blockNumber: null,
      noteKinds: ['payment_reorg'],
      version: 3,
    });
    await s.client.refresh();
    expect(s.data().receipts[5]).toMatchObject({
      stage: 'sent',
      blockNumber: null,
      noteKinds: ['payment_reorg'],
      version: 3,
    });
    stop();
  });
  it('treats a missing version as older', async () => {
    const s = windowed();
    Object.assign(s.rows[0] ?? {}, { stage: 'confirming', version: 2 });
    const stop = s.client.subscribe(() => {});
    await s.load();
    // An event without a version does not replace the versioned row the page holds.
    s.stream.send({ ...s.rows[0], stage: 'sent', version: undefined });
    expect(s.data().receipts[0]).toMatchObject({
      stage: 'confirming',
      version: 2,
    });
    await settle();
    // Nor does a read whose copy has no version.
    s.stream.send({ ...s.rows[1], stage: 'settled', version: 1 });
    await settle();
    Object.assign(s.rows[1] ?? {}, { stage: 'confirming', version: undefined });
    await s.client.refresh();
    expect(s.data().receipts[1]).toMatchObject({
      stage: 'settled',
      version: 1,
    });
    stop();
  });
  it('keeps a newer event over a late read with a lower version', async () => {
    const s = windowed();
    const stop = s.client.subscribe(() => {});
    await s.load();
    for (let i = 0; i < 5; i++) await s.showMore();
    const release = s.holdReads();
    const reads = s.reads.length;
    s.client.showMoreReceipts();
    await vi.waitFor(() => {
      expect(s.reads.length).toBe(reads + 1);
    });
    // The read is in flight; the event moves p110 on, and the read's copy is the older one.
    s.stream.send({ ...s.rows[110], stage: 'settled', version: 5 });
    const p110 = () => s.data().receipts.find((p) => p.id === 'p110');
    expect(p110()?.stage).toBe('settled');
    // Notes come from incidents, so the read's notes apply even to a row the client keeps.
    Object.assign(s.rows[110] ?? {}, { noteKinds: ['paid_after_expiry'] });
    release();
    await vi.waitFor(() => {
      expect(s.data().receipts).toHaveLength(140);
    });
    expect(p110()).toMatchObject({
      stage: 'settled',
      version: 5,
      noteKinds: ['paid_after_expiry'],
    });
    await s.client.refresh();
    expect(p110()).toMatchObject({ stage: 'settled', version: 5 });
    stop();
  });
  it('restores the window size and shows the calm line when Show more fails', async () => {
    const s = windowed();
    const stop = s.client.subscribe(() => {});
    await s.load();
    for (let i = 0; i < 5; i++) await s.showMore();
    const release = s.holdReads();
    s.server.fail = true;
    s.client.showMoreReceipts();
    expect(s.data().olderReceipts).toBe('loading');
    expect(s.data().receipts).toHaveLength(120);
    release();
    await vi.waitFor(() => {
      expect(s.data().olderFailed).toBe(true);
    });
    expect(s.data().olderReceipts).toBe('more');
    expect(s.data().receipts).toHaveLength(120);
    expect(s.client.getSnapshot().status).toBe('live');
    s.server.fail = false;
    const reads = s.reads.length;
    s.client.showMoreReceipts();
    expect(s.data().olderFailed).toBe(false);
    await vi.waitFor(() => {
      expect(s.data().receipts).toHaveLength(140);
    });
    expect(s.reads.slice(reads)).toEqual(['?limit=141']);
    stop();
  });
  it('stops offering more at 200 or when the server has no more', async () => {
    const s = windowed();
    const stop = s.client.subscribe(() => {});
    await s.load();
    for (let i = 0; i < 9; i++) await s.showMore();
    expect(s.data().receipts).toHaveLength(200);
    expect(s.data().olderReceipts).toBe('none');
    const reads = s.reads.length;
    s.client.showMoreReceipts();
    expect(s.reads).toHaveLength(reads);
    stop();

    const few = windowed(50);
    const stopFew = few.client.subscribe(() => {});
    await few.load();
    await few.showMore();
    expect(few.data().olderReceipts).toBe('more');
    await few.showMore();
    expect(few.data().receipts).toHaveLength(50);
    expect(few.data().olderReceipts).toBe('none');
    stopFew();
  });
  it('does not show the older-receipts line when only the background refresh fails', async () => {
    const s = windowed();
    const stop = s.client.subscribe(() => {});
    await s.load();
    for (let i = 0; i < 2; i++) await s.showMore();
    s.server.fail = true;
    await s.client.refresh();
    expect(s.data().olderFailed).toBe(false);
    expect(s.data().olderReceipts).toBe('more');
    expect(s.client.getSnapshot().status).toBe('live');
    const reads = s.reads.length;
    s.stream.disconnect();
    s.stream.open();
    await vi.waitFor(() => {
      expect(s.reads.length).toBeGreaterThan(reads);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.data().olderFailed).toBe(false);
    expect(s.data().olderReceipts).toBe('more');
    expect(s.data().receipts).toHaveLength(60);
    stop();
  });
  it('clears the older-receipts line after a later read succeeds', async () => {
    const s = windowed();
    const stop = s.client.subscribe(() => {});
    await s.load();
    s.server.fail = true;
    s.client.showMoreReceipts();
    await vi.waitFor(() => {
      expect(s.data().olderFailed).toBe(true);
    });
    s.server.fail = false;
    await s.client.refresh();
    expect(s.data().olderFailed).toBe(false);
    expect(s.data().receipts).toHaveLength(20);
    stop();
  });
  it('keeps buffered events bounded while reads fail', async () => {
    const s = windowed();
    const stop = s.client.subscribe(() => {});
    await s.load();
    s.server.fail = true;
    const reads = s.reads.length;
    for (let i = 0; i < 600; i++) {
      s.stream.send({
        ...row(`fresh${i % 300}`, 'received'),
        sentAt: at(-1 - i),
        version: i,
      });
      await settle();
    }
    // The first event starts a read; once it fails, events wait for the retry timer.
    expect(s.reads.length - reads).toBe(1);
    const buffered = (s.client as unknown as { buffered: { size: number } })
      .buffered;
    expect(buffered.size).toBeLessThanOrEqual(200);
    expect(s.client.getSnapshot().status).toBe('live');
    stop();
  });
  it('aborts a superseded read', async () => {
    const s = windowed();
    const stop = s.client.subscribe(() => {});
    await s.load();
    const release = s.holdReads();
    const reads = s.reads.length;
    void s.client.refresh();
    s.client.showMoreReceipts();
    await vi.waitFor(() => {
      expect(s.reads.length).toBe(reads + 2);
    });
    const [first, second] = s.signals.slice(reads);
    expect(first?.aborted).toBe(true);
    expect(second?.aborted).toBe(false);
    release();
    await vi.waitFor(() => {
      expect(s.data().receipts).toHaveLength(40);
    });
    stop();
    expect(second?.aborted).toBe(false);
  });
});
