import { IsUUID } from 'class-validator';
import { ValidationCode } from '../../common/validation';

@ValidationCode('invalid_notice_body')
export class NoticeDto {
  @IsUUID()
  paymentId!: string;
}
