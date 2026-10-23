import type { IncomingHttpHeaders } from 'node:http';
import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
  type RawBodyRequest,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyNotice } from '../../../../libs/core/src/notices';
import { ApiError } from '../common/api-error';
import type { ApiConfig } from '../common/api-config';
import { InjectNow, type Now } from '../common/clock.module';

/** Checks the HMAC over the exact request bytes before the body is parsed into a DTO. */
@Injectable()
export class NoticeSignatureGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService<ApiConfig, true>,
    @InjectNow() private readonly now: Now,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<RawBodyRequest<{ headers: IncomingHttpHeaders }>>();
    const raw = request.rawBody;
    const timestamp = request.headers['x-notice-timestamp'];
    const signature = request.headers['x-notice-signature'];
    if (
      !raw ||
      typeof timestamp !== 'string' ||
      !/^\d+$/.test(timestamp) ||
      typeof signature !== 'string' ||
      !verifyNotice(
        raw.toString('utf8'),
        this.config.get('NOTICE_SECRET', { infer: true }),
        Number(timestamp),
        signature,
        Math.floor(this.now().getTime() / 1000),
      )
    )
      throw new ApiError(401, 'invalid_notice_signature');
    return true;
  }
}
