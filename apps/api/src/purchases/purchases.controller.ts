import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ClientIp } from '../common/client-ip';
import { TestPurchasesService } from './purchases.service';

@Controller('test-purchases')
export class TestPurchasesController {
  constructor(private readonly purchases: TestPurchasesService) {}

  @Post()
  @HttpCode(202)
  buy(@ClientIp() ip: string) {
    return this.purchases.buy(ip);
  }

  @Get(':id')
  position(@Param('id') id: string) {
    return this.purchases.positionOf(id);
  }
}
