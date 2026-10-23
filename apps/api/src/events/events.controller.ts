import { Controller, Sse, type MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { EventsService } from './events.service';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Sse()
  stream(): Observable<MessageEvent> {
    return this.events.stream();
  }
}
