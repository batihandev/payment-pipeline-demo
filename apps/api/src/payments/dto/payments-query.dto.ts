import { IsOptional, IsString, ValidateBy } from 'class-validator';
import { decodePaymentCursor } from '../../../../../libs/core/src/payment-cursor';
import { ListQueryDto } from '../../common/dto/list-query.dto';

export class PaymentsQueryDto extends ListQueryDto {
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
