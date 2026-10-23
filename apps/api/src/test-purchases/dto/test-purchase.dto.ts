import { IsIn, IsOptional } from 'class-validator';
import { ValidationCode } from '../../common/validation';

export const PAYMENT_RAILS = ['chain', 'card'] as const;

@ValidationCode('invalid_purchase_body')
export class TestPurchaseDto {
  @IsOptional()
  @IsIn(PAYMENT_RAILS)
  rail: (typeof PAYMENT_RAILS)[number] = 'chain';
}
