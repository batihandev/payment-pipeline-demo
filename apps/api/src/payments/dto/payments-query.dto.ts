import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateBy,
} from 'class-validator';
import { decodePaymentCursor } from '../../../../../libs/core/src/payment-cursor';
import { PAYMENT_LIST_MAX } from '../../../../../libs/core/src/payment-list';

export class PaymentsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAYMENT_LIST_MAX)
  limit: number = 20;

  /** Lists only payments older than this cursor, made by `encodePaymentCursor`. */
  @IsOptional()
  @IsString()
  @ValidateBy({
    name: 'isPaymentCursor',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && decodePaymentCursor(value) !== null,
    },
  })
  before?: string;
}
