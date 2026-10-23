import { Controller, Get } from '@nestjs/common';
import type { HealthRecord } from '../../../../libs/core/src/api';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  read(): Promise<HealthRecord> {
    return this.health.read();
  }
}
