import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startQueuePolling } from './use-queue-position';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
describe('queue position polling', () => {
  it('keeps polling after a 503 and stops when the position reaches 0', async () => {
    const replies = [
      json({}, 503),
      json({ position: 2 }),
      json({ position: 0 }),
    ];
    const request = vi.fn(async () => replies.shift() ?? json({ position: 0 }));
    const seen: number[] = [];
    startQueuePolling({
      baseUrl: 'http://api',
      orderId: 'a',
      initialPosition: 3,
      request,
      onPosition: (p) => seen.push(p),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual([2]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual([2, 0]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('ignores a response for a previous order', async () => {
    let release: (r: Response) => void = () => {};
    const request = vi.fn(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    const seen: Array<[string, number]> = [];
    const stop = startQueuePolling({
      baseUrl: 'http://api',
      orderId: 'old',
      initialPosition: 4,
      request,
      onPosition: (p) => seen.push(['old', p]),
    });
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    startQueuePolling({
      baseUrl: 'http://api',
      orderId: 'new',
      initialPosition: 5,
      request: async () => json({ position: 5 }),
      onPosition: (p) => seen.push(['new', p]),
    });
    release(json({ position: 0 }));
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
      return json({ position: 3 });
    });
    startQueuePolling({
      baseUrl: 'http://api',
      orderId: 'a',
      initialPosition: 3,
      request,
      onPosition: () => {},
    });
    await vi.advanceTimersByTimeAsync(12000);
    expect(request.mock.calls.length).toBeGreaterThan(1);
    expect(peak).toBe(1);
  });
});
