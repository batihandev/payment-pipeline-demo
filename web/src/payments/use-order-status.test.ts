import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOrderPolling, type OrderStatus } from './use-order-status';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
describe('order status polling', () => {
  it('keeps polling after a 503 and stops when the order closes', async () => {
    const replies = [
      json({}, 503),
      json({ position: 2, closed: false }),
      json({ position: 0, closed: false }),
      json({ position: 0, closed: true }),
    ];
    const request = vi.fn(
      async () => replies.shift() ?? json({ position: 0, closed: true }),
    );
    const seen: OrderStatus[] = [];
    startOrderPolling({
      baseUrl: 'http://api',
      orderId: 'a',
      request,
      onStatus: (status) => seen.push(status),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual([{ position: 2, closed: false }]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toEqual([
      { position: 2, closed: false },
      { position: 0, closed: false },
      { position: 0, closed: true },
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledTimes(4);
  });
  it('keeps polling an order that left the queue until it closes or the page stops it', async () => {
    const request = vi.fn(async () => json({ position: 0, closed: false }));
    const stop = startOrderPolling({
      baseUrl: 'http://api',
      orderId: 'a',
      request,
      onStatus: () => {},
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenCalledWith(
      'http://api/test-purchases/a',
      expect.anything(),
    );
    stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('ignores a response for a previous order', async () => {
    let release: (r: Response) => void = () => {};
    const request = vi.fn(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    const seen: Array<[string, OrderStatus]> = [];
    const stop = startOrderPolling({
      baseUrl: 'http://api',
      orderId: 'old',
      request,
      onStatus: (s) => seen.push(['old', s]),
    });
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    startOrderPolling({
      baseUrl: 'http://api',
      orderId: 'new',
      request: async () => json({ position: 5, closed: false }),
      onStatus: (s) => seen.push(['new', s]),
    });
    release(json({ position: 0, closed: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
  });
  it('never has two requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const request = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 3500));
      inFlight--;
      return json({ position: 3, closed: false });
    });
    startOrderPolling({
      baseUrl: 'http://api',
      orderId: 'a',
      request,
      onStatus: () => {},
    });
    await vi.advanceTimersByTimeAsync(12000);
    expect(request.mock.calls.length).toBeGreaterThan(1);
    expect(peak).toBe(1);
  });
});
