import type { Dashboard, Payment, Snapshot } from './types';

export type EventStream = Pick<
  EventSource,
  'onopen' | 'onerror' | 'onmessage' | 'close'
>;
export class PaymentsClient {
  private snapshot: Snapshot = { status: 'loading', data: null };
  private listeners = new Set<() => void>();
  private stream?: EventStream;
  private generation = 0;
  private buffered: Payment[] = [];
  private loading = false;
  private retry?: ReturnType<typeof setTimeout>;
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
    if (this.listeners.size === 1) this.connect();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.generation++;
        this.stream?.close();
        this.stream = undefined;
        clearTimeout(this.retry);
        this.loading = false;
      }
    };
  };
  private update(snapshot: Snapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  private connect() {
    this.stream = this.createStream(`${this.baseUrl}/events`);
    this.stream.onopen = () => {
      this.generation++;
      this.loading = false;
      this.buffered = [];
      this.update({ status: 'loading', data: null });
      void this.refresh();
    };
    this.stream.onerror = () => {
      this.generation++;
      this.loading = false;
      clearTimeout(this.retry);
      this.update({ status: 'offline', data: null });
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
    void this.refresh();
  }
  private merge(data: Dashboard, events: Payment[]): Dashboard {
    const rows = new Map(data.payments.map((p) => [p.id, p]));
    for (const event of events) {
      const previous = rows.get(event.id);
      rows.set(event.id, {
        ...previous,
        ...event,
        order:
          event.order ??
          (previous?.orderId === event.orderId ? previous.order : null),
        explorerUrl:
          event.explorerUrl ??
          (previous?.transactionHash === event.transactionHash
            ? previous.explorerUrl
            : null),
      });
    }
    return {
      ...data,
      payments: [...rows.values()]
        .sort(
          (a, b) =>
            (b.sentAt ?? b.receivedAt ?? '').localeCompare(
              a.sentAt ?? a.receivedAt ?? '',
            ) || b.id.localeCompare(a.id),
        )
        .slice(0, 100),
    };
  }
  async refresh(): Promise<void> {
    if (this.loading || !this.listeners.size) return;
    this.loading = true;
    clearTimeout(this.retry);
    const generation = this.generation;
    try {
      const paths = [
        '/payments?limit=100',
        '/stats',
        '/stats/daily',
        '/health',
        '/incidents?limit=100',
      ];
      const [payments, stats, daily, health, incidents] = await Promise.all(
        paths.map(async (path) => {
          const request = this.request;
          const response = await request(`${this.baseUrl}${path}`);
          if (!response.ok) throw new Error('Demo offline');
          return response.json() as Promise<unknown>;
        }),
      );
      if (generation !== this.generation) return;
      const data = { payments, stats, daily, health, incidents } as Dashboard;
      this.update({ status: 'live', data: this.merge(data, this.buffered) });
      this.buffered = [];
    } catch {
      if (generation !== this.generation) return;
      this.update({ status: 'offline', data: null });
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
