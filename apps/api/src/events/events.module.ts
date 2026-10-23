import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { StreamLimit } from './stream-limit';

@Module({
  controllers: [EventsController],
  providers: [EventsService, StreamLimit],
})
export class EventsModule {}
