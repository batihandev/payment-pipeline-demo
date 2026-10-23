import {
  encodePaymentCursor,
  paymentCursor,
} from '../../../libs/core/src/payment-cursor';
import type { Dashboard, Health, Payment, Snapshot } from './types';

export type Rail = 'chain' | 'card';
export type PurchaseAnswer = {
  ok: boolean;
  status: number;
  retryAfter: string | null;
  body: {
    orderId?: string;
    position?: number;
    item?: string;
    price?: string;
    /** When the order expires, as an ISO timestamp. */
    expiresAt?: string;
    error?: string;
  };
};

export const HEALTH_EVERY_MS = 15000;
/** How many payments the live list holds; the pipeline counts cover these. */
const LIVE_LIMIT = 100;
/** How many receipts show at first, and how many each Show more adds. */
export const RECEIPT_PAGE = 20;

type Feed = Omit<Dashboard, 'receipts' | 'olderReceipts'>;

function newestFirst(a: Payment, b: Payment): number {
  return (
    (b.sentAt ?? b.receivedAt ?? '').localeCompare(
      a.sentAt ?? a.receivedAt ?? '',
    ) || b.id.localeCompare(a.id)
  );
}
export const STREAM_REOPEN_MS = 30000;

/** A change to a visitor order, or the stream opening, which may mean updates were missed. */
export type OrderUpdate =
  | { type: 'order'; id: string; closed: boolean }
  | { type: 'queue'; waiting: string[] }
  | { type: 'opened' };

export type EventStream = Pick<
  EventSource,
  'onopen' | 'onerror' | 'onmessage' | 'close'
> & {
  addEventListener(
    type: 'order' | 'queue',
    listener: (event: { data: string }) => void,
  ): void;
};

function readOrderUpdate(data: string): OrderUpdate | undefined {
  try {
    const update = JSON.parse(data) as Record<string, unknown>;
    if (
      update.type === 'order' &&
      typeof update.id === 'string' &&
      typeof update.closed === 'boolean'
    )
      return { type: 'order', id: update.id, closed: update.closed };
    if (
      update.type === 'queue' &&
      Array.isArray(update.waiting) &&
      update.waiting.every((id) => typeof id === 'string')
    )
      return { type: 'queue', waiting: update.waiting as string[] };
  } catch {
    // an unreadable update is skipped
  }
  return undefined;
}
export class PaymentsClient {
  private snapshot: Snapshot = { status: 'loading', data: null };
  private listeners = new Set<() => void>();
  private orderListeners = new Set<(update: OrderUpdate) => void>();
  private stream?: EventStream;
  private generation = 0;
  private buffered: Payment[] = [];
  private loading = false;
  private retry?: ReturnType<typeof setTimeout>;
  private reopen?: ReturnType<typeof setTimeout>;
  private health: Health | null = null;
  private healthTimer?: ReturnType<typeof setInterval>;
  private receiptCount = RECEIPT_PAGE;
  /** Payments older than the live list: pages read with Show more, and rows it pushed out. */
  private older = new Map<string, Payment>();
  private olderLoading = false;
  private oldestReached = false;
  readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private request: typeof fetch = fetch,
    private createStream: (url: string) => EventStream = (url) =>
      new EventSource(url),
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }
  getSnapshot = (): Snapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.openStream();
      this.start();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.generation++;
        this.stream?.close();
        this.stream = undefined;
        clearTimeout(this.retry);
        clearTimeout(this.reopen);
        clearInterval(this.healthTimer);
        this.loading = false;
      }
    };
  };
  /** Follows visitor order changes on the event stream; the stream itself follows `subscribe`. */
  onOrderUpdate = (listener: (update: OrderUpdate) => void): (() => void) => {
    this.orderListeners.add(listener);
    return () => {
      this.orderListeners.delete(listener);
    };
  };
  private sendOrderUpdate(update: OrderUpdate) {
    for (const listener of this.orderListeners) listener(update);
  }
  private update(snapshot: { status: Snapshot['status']; data: Feed | null }) {
    this.snapshot = {
      status: snapshot.status,
      data: snapshot.data && this.withReceipts(snapshot.data),
    };
    for (const listener of this.listeners) listener();
  }
  private withReceipts(feed: Feed): Dashboard {
    const shown = this.snapshot.data;
    if (this.receiptCount > RECEIPT_PAGE && shown) {
      const live = new Set(feed.payments.map((p) => p.id));
      for (const p of shown.payments)
        if (!live.has(p.id)) this.older.set(p.id, p);
    }
    for (const p of feed.payments) this.older.delete(p.id);
    const all = [...feed.payments, ...this.older.values()].sort(newestFirst);
    const canRead = this.canReadOlder(feed.payments);
    return {
      ...feed,
      receipts: all.slice(0, this.receiptCount),
      olderReceipts: this.olderLoading
        ? 'loading'
        : all.length > this.receiptCount || canRead
          ? 'more'
          : 'none',
    };
  }
  /** Older payments exist on the server only past a full live list, until a short page ends them. */
  private canReadOlder(live: readonly Payment[]): boolean {
    return !this.oldestReached && live.length >= LIVE_LIMIT;
  }
  /** Shows the next page of receipts, reading older payments from the API when needed. */
  showMoreReceipts = (): void => {
    const data = this.snapshot.data;
    if (!data || this.olderLoading || data.olderReceipts === 'none') return;
    this.receiptCount += RECEIPT_PAGE;
    const known = data.payments.length + this.older.size;
    if (known >= this.receiptCount || !this.canReadOlder(data.payments)) {
      this.update(this.snapshot);
      return;
    }
    const last = [...data.payments, ...this.older.values()]
      .sort(newestFirst)
      .at(-1);
    if (!last) return;
    this.olderLoading = true;
    this.update(this.snapshot);
    void this.readOlder(encodePaymentCursor(paymentCursor(last)));
  };
  private async readOlder(before: string): Promise<void> {
    const request = this.request;
    try {
      const response = await request(
        `${this.baseUrl}/payments?limit=${RECEIPT_PAGE}&before=${before}`,
      );
      if (!response.ok) throw new Error('Demo offline');
      const rows = (await response.json()) as Payment[];
      const live = new Set(this.snapshot.data?.payments.map((p) => p.id));
      for (const p of rows) if (!live.has(p.id)) this.older.set(p.id, p);
      if (rows.length < RECEIPT_PAGE) this.oldestReached = true;
    } catch {
      // A failed read keeps what is shown; Show more stays available to try again.
      this.receiptCount -= RECEIPT_PAGE;
    } finally {
      this.olderLoading = false;
      this.update(this.snapshot);
    }
  }
  private openStream() {
    this.stream = this.createStream(`${this.baseUrl}/events`);
    this.stream.onopen = () => {
      this.generation++;
      this.loading = false;
      this.buffered = [];
      void this.refresh();
      this.sendOrderUpdate({ type: 'opened' });
    };
    for (const type of ['order', 'queue'] as const)
      this.stream.addEventListener(type, (event) => {
        const update = readOrderUpdate(event.data);
        if (update) this.sendOrderUpdate(update);
      });
    this.stream.onerror = () => {
      if (!this.listeners.size) return;
      this.stream?.close();
      this.stream = undefined;
      clearTimeout(this.reopen);
      this.reopen = setTimeout(() => {
        this.openStream();
      }, STREAM_REOPEN_MS);
    };
    this.stream.onmessage = (event) => {
      try {
        const payment = JSON.parse(event.data) as Payment;
        if (!payment.id || !payment.stage)
          throw new Error('Invalid payment event');
        if (this.loading) this.buffered.push(payment);
        else {
          if (this.snapshot.data)
            this.update({
              status: 'live',
              data: this.merge(this.snapshot.data, [payment]),
            });
          this.buffered.push(payment);
          void this.refresh();
        }
      } catch {
        void this.refresh();
      }
    };
  }
  private start() {
    void this.refresh();
    void this.refreshHealth();
    this.healthTimer = setInterval(() => {
      void this.refreshHealth();
    }, HEALTH_EVERY_MS);
  }
  // Health is polled on its own timer, not per event, and a failed read keeps the last one:
  // it describes the services behind the demo and never takes the page offline.
  private async refreshHealth(): Promise<void> {
    const request = this.request;
    try {
      const response = await request(`${this.baseUrl}/health`);
      if (!response.ok) return;
      this.health = (await response.json()) as Health;
    } catch {
      return;
    }
    if (!this.listeners.size || !this.snapshot.data) return;
    this.update({
      ...this.snapshot,
      data: { ...this.snapshot.data, health: this.health },
    });
  }
  private merge(data: Feed, events: Payment[]): Feed {
    const rows = new Map(data.payments.map((p) => [p.id, p]));
    for (const event of events) {
      const previous = rows.get(event.id) ?? this.older.get(event.id);
      const merged: Payment = {
        ...previous,
        ...event,
        order:
          event.order ??
          (previous?.orderId === event.orderId ? previous.order : null),
        noteKinds: previous?.noteKinds ?? [],
        explorerUrl:
          event.explorerUrl ??
          (previous?.transactionHash === event.transactionHash
            ? previous.explorerUrl
            : null),
      };
      rows.set(event.id, merged);
      if (this.older.has(event.id)) this.older.set(event.id, merged);
    }
    return {
      ...data,
      payments: [...rows.values()].sort(newestFirst).slice(0, LIVE_LIMIT),
    };
  }
  async purchase(rail: Rail): Promise<PurchaseAnswer> {
    const request = this.request;
    const response = await request(`${this.baseUrl}/test-purchases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rail }),
    });
    return {
      ok: response.ok,
      status: response.status,
      retryAfter: response.headers.get('retry-after'),
      body: (await response.json()) as PurchaseAnswer['body'],
    };
  }
  async refresh(): Promise<void> {
    if (this.loading || !this.listeners.size) return;
    this.loading = true;
    clearTimeout(this.retry);
    const generation = this.generation;
    try {
      const paths = [`/payments?limit=${LIVE_LIMIT}`, '/stats', '/stats/daily'];
      const [payments, stats, daily] = await Promise.all(
        paths.map(async (path) => {
          const request = this.request;
          const response = await request(`${this.baseUrl}${path}`);
          if (!response.ok) throw new Error('Demo offline');
          return response.json() as Promise<unknown>;
        }),
      );
      if (generation !== this.generation) return;
      const data = {
        payments,
        stats,
        daily,
        health: this.health,
      } as Feed;
      this.update({ status: 'live', data: this.merge(data, this.buffered) });
      this.buffered = [];
    } catch {
      if (generation !== this.generation) return;
      if (!this.snapshot.data) this.update({ status: 'offline', data: null });
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.retry = setTimeout(() => {
          void this.refresh();
        }, 15000);
      }
    }
  }
}
