import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ClientIp } from '../common/client-ip';
import { TestPurchaseDto } from './dto/test-purchase.dto';
import { TestPurchasesService } from './test-purchases.service';

@Controller('test-purchases')
export class TestPurchasesController {
  constructor(private readonly purchases: TestPurchasesService) {}

  @Post()
  @HttpCode(202)
  buy(@ClientIp() ip: string, @Body() body: TestPurchaseDto) {
    return this.purchases.buy(ip, body.rail);
  }

  @Get(':id')
  position(@Param('id') id: string) {
    return this.purchases.positionOf(id);
  }
}
