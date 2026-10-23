import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { NoticeDto } from './dto/notice.dto';
import { NoticeSignatureGuard } from './notice-signature.guard';
import { NoticesService } from './notices.service';

@Controller('shop/notices')
export class NoticesController {
  constructor(private readonly notices: NoticesService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(NoticeSignatureGuard)
  async accept(@Body() body: NoticeDto): Promise<{ ok: true }> {
    await this.notices.deliver(body.paymentId);
    return { ok: true };
  }
}
