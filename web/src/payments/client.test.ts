import { describe, expect, it, vi } from 'vitest';
import { PaymentsClient, type EventStream } from './client';

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
});
function server() {
  let payments = [row('old')];
  let settledCount = 0;
  let available = true;
  let hold: Promise<void> = Promise.resolve();
  const stream = new FakeEventSource();
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
        '/incidents?limit=100': [],
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
      await hold;
      if (!available) throw new Error('offline');
      return new Response(
        JSON.stringify(
          snapshot[
            (new URL(String(url)).pathname +
              new URL(String(url)).search) as keyof typeof snapshot
          ],
        ),
      );
    },
    () => stream,
  );
  return {
    client,
    stream,
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
    expect(s.client.getSnapshot().status).toBe('loading');
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
  it('shows offline instead of stale data when the API cannot be reached', async () => {
    const s = server();
    s.offline();
    const stop = s.client.subscribe(() => {});
    s.stream.open();
    await vi.waitFor(() =>
      expect(s.client.getSnapshot().status).toBe('offline'),
    );
    expect(s.client.getSnapshot().data).toBeNull();
    stop();
  });
});
