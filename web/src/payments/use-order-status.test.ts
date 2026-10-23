import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderUpdate } from './client';
import { followOrder, type OrderStatus } from './use-order-status';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
function updates() {
  const listeners = new Set<(update: OrderUpdate) => void>();
  return {
    client: {
      baseUrl: 'http://api',
      onOrderUpdate: (listener: (update: OrderUpdate) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    send: (update: OrderUpdate) => {
      for (const listener of listeners) listener(update);
    },
    listening: () => listeners.size,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
describe('order status', () => {
  it('reads the order once when it is accepted and once when the stream reopens', async () => {
    const stream = updates();
    const request = vi.fn(() =>
      Promise.resolve(json({ position: 2, closed: false })),
    );
    const seen: OrderStatus[] = [];
    followOrder({
      client: stream.client,
      orderId: 'a',
      request,
      onStatus: (status) => seen.push(status),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      'http://api/test-purchases/a',
      expect.anything(),
    );
    expect(seen).toEqual([{ position: 2, closed: false }]);
    stream.send({ type: 'opened' });
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('does not poll the order', async () => {
    const stream = updates();
    const request = vi.fn(() => Promise.resolve(json({}, 503)));
    followOrder({
      client: stream.client,
      orderId: 'a',
      request,
      onStatus: () => {},
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('reads the queue position from the stream', async () => {
    const stream = updates();
    const seen: OrderStatus[] = [];
    followOrder({
      client: stream.client,
      orderId: 'a',
      request: () => Promise.resolve(json({ position: 3, closed: false })),
      onStatus: (status) => seen.push(status),
    });
    await vi.advanceTimersByTimeAsync(0);
    stream.send({ type: 'queue', waiting: ['b', 'a'] });
    stream.send({ type: 'queue', waiting: ['c'] });
    expect(seen).toEqual([
      { position: 3, closed: false },
      { position: 2, closed: false },
      { position: 0, closed: false },
    ]);
  });
  it('closes on an order event for this order only, and stays closed', async () => {
    const stream = updates();
    const seen: OrderStatus[] = [];
    followOrder({
      client: stream.client,
      orderId: 'a',
      request: () => Promise.resolve(json({ position: 0, closed: false })),
      onStatus: (status) => seen.push(status),
    });
    await vi.advanceTimersByTimeAsync(0);
    stream.send({ type: 'order', id: 'b', closed: true });
    stream.send({ type: 'order', id: 'a', closed: false });
    stream.send({ type: 'order', id: 'a', closed: true });
    stream.send({ type: 'opened' });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([
      { position: 0, closed: false },
      { position: 0, closed: true },
      { position: 0, closed: true },
    ]);
  });
  it('ignores a response and updates after it is stopped', async () => {
    const stream = updates();
    let release: (response: Response) => void = () => {};
    const seen: OrderStatus[] = [];
    const stop = followOrder({
      client: stream.client,
      orderId: 'a',
      request: () => new Promise<Response>((resolve) => (release = resolve)),
      onStatus: (status) => seen.push(status),
    });
    stop();
    release(json({ position: 0, closed: true }));
    stream.send({ type: 'order', id: 'a', closed: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
    expect(stream.listening()).toBe(0);
  });
});
