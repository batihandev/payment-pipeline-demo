import { Controller, Get, HttpCode, Ip, Param, Post } from '@nestjs/common';
import { TestPurchasesService } from './purchases.service';

@Controller('test-purchases')
export class TestPurchasesController {
  constructor(private readonly purchases: TestPurchasesService) {}

  @Post()
  @HttpCode(202)
  buy(@Ip() ip: string) {
    return this.purchases.buy(ip);
  }

  @Get(':id')
  position(@Param('id') id: string) {
    return this.purchases.positionOf(id);
  }
}
