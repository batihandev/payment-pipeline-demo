import {
  PAYMENT_LIST_MAX,
  PAYMENT_LIST_STEP,
} from '../../../libs/core/src/payment-list';
import type { DailyStat, Health, Payment, Snapshot, Stats } from './types';

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
const REFRESH_EVERY_MS = 15000;
/** How many of the newest payments the pipeline counts cover. */
const PIPELINE_LIMIT = 100;
/** How many receipts show at first, and how many each Show more adds. */
export const RECEIPT_PAGE = PAYMENT_LIST_STEP;

/** The newest payments, as one read returned them with live events merged in. */
type Feed = { rows: Payment[]; stats: Stats; daily: DailyStat[] };

/** One read covers the receipt window and the pipeline counts. */
function readLimit(windowSize: number): number {
  return Math.max(windowSize, PIPELINE_LIMIT);
}

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
      return { type: 'queue', waiting: update.waiting };
  } catch {
    // an unreadable update is skipped
  }
  return undefined;
}
function isPaymentEvent(value: unknown): value is Payment {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'stage' in value &&
    typeof value.stage === 'string'
  );
}
/** Whether `a` is a later copy of the row than `b`. A copy without a version is older than any versioned copy. */
function isNewer(a: Pick<Payment, 'version'>, b: Pick<Payment, 'version'>) {
  return (a.version ?? -1) > (b.version ?? -1);
}

export class PaymentsClient {
  private snapshot: Snapshot = { status: 'loading', data: null };
  private status: Snapshot['status'] = 'loading';
  private feed: Feed | null = null;
  private listeners = new Set<() => void>();
  private orderListeners = new Set<(update: OrderUpdate) => void>();
  private stream?: EventStream;
  /** How many receipts the page shows. */
  private windowSize = RECEIPT_PAGE;
  /** Whether the last read filled its limit, so older payments may exist. */
  private full = false;
  /**
   * Bumped by each read, reopen and unsubscribe; a read whose epoch has moved on is dropped,
   * and its requests are aborted.
   */
  private epoch = 0;
  private abort?: AbortController;
  /** The read in flight: the window size it reads, and whether Show more asked for it. */
  private reading?: { size: number; more: boolean };
  private olderFailed = false;
  /** Whether the last read failed; events then wait for the retry timer instead of reading. */
  private failing = false;
  /**
   * The newest event for each payment since the last completed read; they are applied again
   * over its rows. It holds at most `PAYMENT_LIST_MAX` payments.
   */
  private buffered = new Map<string, Payment>();
  private retry?: ReturnType<typeof setTimeout>;
  private reopen?: ReturnType<typeof setTimeout>;
  private health: Health | null = null;
  private healthTimer?: ReturnType<typeof setInterval>;
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
        this.supersede();
        this.reading = undefined;
        this.stream?.close();
        this.stream = undefined;
        clearTimeout(this.retry);
        clearTimeout(this.reopen);
        clearInterval(this.healthTimer);
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
  private publish() {
    const feed = this.feed;
    this.snapshot = {
      status: this.status,
      data: feed && {
        payments: feed.rows.slice(0, PIPELINE_LIMIT),
        receipts: feed.rows.slice(0, this.windowSize),
        olderReceipts: this.reading?.more
          ? 'loading'
          : this.windowSize < PAYMENT_LIST_MAX &&
              (feed.rows.length > this.windowSize || this.full)
            ? 'more'
            : 'none',
        olderFailed: this.olderFailed,
        stats: feed.stats,
        daily: feed.daily,
        health: this.health,
      },
    };
    for (const listener of this.listeners) listener();
  }
  /** Reads the window one page larger; on failure the window keeps its size. */
  showMoreReceipts = (): void => {
    if (this.snapshot.data?.olderReceipts !== 'more') return;
    this.olderFailed = false;
    void this.read(this.windowSize + RECEIPT_PAGE, true);
  };
  private openStream() {
    this.stream = this.createStream(`${this.baseUrl}/events`);
    this.stream.onopen = () => {
      this.buffered.clear();
      // Updates may have been missed: read the window again, keeping a Show more in flight.
      const pending = this.reading?.more ? this.reading.size : undefined;
      void this.read(pending ?? this.windowSize, pending !== undefined);
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
    this.stream.onmessage = (event: MessageEvent<string>) => {
      try {
        const payment: unknown = JSON.parse(event.data);
        if (!isPaymentEvent(payment)) throw new Error('Invalid payment event');
        this.buffer(payment);
        if (this.feed) {
          this.applyEvents([payment]);
          this.status = 'live';
          this.publish();
        }
      } catch {
        // An unreadable event is skipped; the refresh below reads the current rows.
      }
      if (!this.failing) void this.refresh();
    };
  }
  private buffer(payment: Payment) {
    const held = this.buffered.get(payment.id);
    if (held && isNewer(held, payment)) return;
    this.buffered.delete(payment.id);
    this.buffered.set(payment.id, payment);
    // The oldest entries go first; the next read returns those payments anyway.
    for (const id of this.buffered.keys()) {
      if (this.buffered.size <= PAYMENT_LIST_MAX) break;
      this.buffered.delete(id);
    }
  }
  /** Drops the read in flight and aborts its requests. */
  private supersede() {
    this.epoch++;
    this.abort?.abort();
    this.abort = undefined;
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
    if (this.listeners.size && this.feed) this.publish();
  }
  /** Merges live events into the rows; a row with a higher version is newer and stays. */
  private applyEvents(events: Iterable<Payment>) {
    if (!this.feed) return;
    const rows = new Map(this.feed.rows.map((p) => [p.id, p]));
    for (const event of events) {
      const previous = rows.get(event.id);
      if (previous && isNewer(previous, event)) continue;
      rows.set(event.id, {
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
      });
    }
    this.feed = {
      ...this.feed,
      rows: [...rows.values()]
        .sort(newestFirst)
        .slice(0, readLimit(this.windowSize)),
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
  /** Reads the window again at its size, unless a read is already in flight. */
  async refresh(): Promise<void> {
    if (this.reading || !this.listeners.size) return;
    await this.read(this.windowSize, false);
  }
  /**
   * Reads the newest `size` receipts in one request, with the statistics, and replaces the
   * window. Starting a read drops any read still in flight. Only a Show more read that fails
   * shows the older-receipts line; the window then keeps its previous size.
   */
  private async read(size: number, more: boolean): Promise<void> {
    this.supersede();
    const epoch = this.epoch;
    const abort = new AbortController();
    this.abort = abort;
    this.reading = { size, more };
    clearTimeout(this.retry);
    if (more && this.feed) this.publish();
    const limit = readLimit(size);
    try {
      const paths = [`/payments?limit=${limit}`, '/stats', '/stats/daily'];
      const [payments, stats, daily] = await Promise.all(
        paths.map(async (path) => {
          const request = this.request;
          const response = await request(`${this.baseUrl}${path}`, {
            signal: abort.signal,
          });
          if (!response.ok) throw new Error('Demo offline');
          return response.json() as Promise<unknown>;
        }),
      );
      if (epoch !== this.epoch) return;
      const rows = payments as Payment[];
      const held = new Map(this.feed?.rows.map((p) => [p.id, p]));
      this.windowSize = size;
      this.full = rows.length >= limit;
      this.feed = {
        // An event that arrived during the read may be newer than the read's copy. Notes come
        // from incidents rather than the row, so they always come from the read.
        rows: rows.map((p) => {
          const known = held.get(p.id);
          return known && isNewer(known, p)
            ? { ...known, noteKinds: p.noteKinds }
            : p;
        }),
        stats: stats as Stats,
        daily: daily as DailyStat[],
      };
      this.applyEvents(this.buffered.values());
      this.buffered.clear();
      this.status = 'live';
      this.olderFailed = false;
      this.failing = false;
    } catch {
      if (epoch !== this.epoch) return;
      this.failing = true;
      if (more) this.olderFailed = true;
      else if (!this.feed) this.status = 'offline';
    }
    this.reading = undefined;
    this.abort = undefined;
    this.retry = setTimeout(() => {
      void this.refresh();
    }, REFRESH_EVERY_MS);
    this.publish();
  }
}
