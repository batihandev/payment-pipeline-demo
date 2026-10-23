import { Controller, Get, Query } from '@nestjs/common';
import type { PaymentListItemRecord } from '../../../../libs/core/src/api';
import { decodePaymentCursor } from '../../../../libs/core/src/payment-cursor';
import { PaymentsQueryDto } from './dto/payments-query.dto';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  list(@Query() query: PaymentsQueryDto): Promise<PaymentListItemRecord[]> {
    return this.payments.list(
      query.limit,
      query.before === undefined ? null : decodePaymentCursor(query.before),
    );
  }
}
