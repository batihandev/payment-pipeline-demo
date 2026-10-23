import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** The client address Express resolved, which honours `trust proxy`. */
export function clientIp(request: Request): string {
  return request.ip ?? 'unknown';
}

export const ClientIp = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    clientIp(context.switchToHttp().getRequest<Request>()),
);
