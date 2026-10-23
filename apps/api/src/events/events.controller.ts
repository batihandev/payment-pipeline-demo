import { Controller, Sse, type MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { EventsService } from './events.service';

/** Characters of unsent data after which a client that stopped reading is dropped. */
export const SLOW_CLIENT_LIMIT = 16 * 1024;

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Sse(undefined, { maxPendingDataLength: SLOW_CLIENT_LIMIT })
  stream(): Observable<MessageEvent> {
    return this.events.stream();
  }
}
