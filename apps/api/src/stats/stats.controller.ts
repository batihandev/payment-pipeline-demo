import { Controller, Get } from '@nestjs/common';
import { StatsService } from './stats.service';

@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  today() {
    return this.stats.today();
  }

  @Get('daily')
  daily() {
    return this.stats.daily();
  }
}
