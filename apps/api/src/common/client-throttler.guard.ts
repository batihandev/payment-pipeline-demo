import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { clientIp } from './client-ip';

@Injectable()
export class ClientThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(
    request: Record<string, unknown>,
  ): Promise<string> {
    return Promise.resolve(clientIp(request as unknown as Request));
  }
}
