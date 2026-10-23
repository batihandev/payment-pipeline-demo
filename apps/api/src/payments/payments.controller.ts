import { Controller, Get, Query } from '@nestjs/common';
import { ListQueryDto } from './dto/list-query.dto';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  list(@Query() query: ListQueryDto): Promise<unknown> {
    return this.payments.list(query.limit);
  }
}
