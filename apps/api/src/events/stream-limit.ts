import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApiConfig } from '../common/api-config';

/** Counts open live streams per client address and in total. */
@Injectable()
export class StreamLimit {
  private readonly perAddress = new Map<string, number>();
  private open = 0;

  constructor(private readonly config: ConfigService<ApiConfig, true>) {}

  /** A function that frees the slot, or null when either cap is reached. */
  acquire(address: string): (() => void) | null {
    const held = this.perAddress.get(address) ?? 0;
    if (
      held >= this.config.get('STREAMS_PER_IP', { infer: true }) ||
      this.open >= this.config.get('STREAMS_TOTAL', { infer: true })
    )
      return null;
    this.perAddress.set(address, held + 1);
    this.open += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.open -= 1;
      const left = (this.perAddress.get(address) ?? 1) - 1;
      if (left > 0) this.perAddress.set(address, left);
      else this.perAddress.delete(address);
    };
  }
}
