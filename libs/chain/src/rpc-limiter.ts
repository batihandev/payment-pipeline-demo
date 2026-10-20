import { setTimeout } from 'node:timers/promises';
import { RpcError } from './rpc-error';

export class RpcLimiter {
  private tail: Promise<unknown> = Promise.resolve();
  private nextStart = 0;
  private cooldownUntil = 0;
  constructor(
    private readonly rate: number,
    private readonly cooldown: number,
    private readonly now = Date.now,
    private readonly sleep: (ms: number) => Promise<unknown> = setTimeout,
    private readonly reportCooldown?: () => Promise<void>,
  ) {
    if (rate <= 0 || cooldown <= 0)
      throw new RangeError('RPC limits must be positive');
  }
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = Math.max(this.nextStart, this.cooldownUntil) - this.now();
      if (wait > 0) await this.sleep(wait);
      this.nextStart = this.now() + Math.ceil(1000 / this.rate);
      try {
        return await operation();
      } catch (error) {
        if (error instanceof RpcError && error.kind === 'rate_limit') {
          this.cooldownUntil = this.now() + this.cooldown;
          await this.reportCooldown?.();
        }
        throw error;
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
