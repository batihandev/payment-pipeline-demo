import { Controller, Req, Sse, type MessageEvent } from '@nestjs/common';
import type { Request } from 'express';
import { finalize, type Observable } from 'rxjs';
import { ApiError } from '../common/api-error';
import { clientIp } from '../common/client-ip';
import { EventsService } from './events.service';
import { StreamLimit } from './stream-limit';

/** Characters of unsent data after which a client that stopped reading is dropped. */
export const SLOW_CLIENT_LIMIT = 16 * 1024;
const RETRY_AFTER_SECONDS = '5';

@Controller('events')
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly streams: StreamLimit,
  ) {}

  @Sse(undefined, { maxPendingDataLength: SLOW_CLIENT_LIMIT })
  stream(@Req() request: Request): Observable<MessageEvent> {
    const release = this.streams.acquire(clientIp(request));
    if (!release)
      throw new ApiError(
        429,
        'rate_limited',
        {},
        { 'Retry-After': RETRY_AFTER_SECONDS },
      );
    return this.events.stream().pipe(finalize(release));
  }
}
