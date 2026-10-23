import { isIP } from 'node:net';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Express setting that holds the configured `CLIENT_IP_HEADER`, if any. */
export const CLIENT_IP_HEADER_SETTING = 'client ip header';

/**
 * The visitor's address: the configured client header when it holds a valid address,
 * otherwise the socket's remote address. Forwarding headers are never read.
 */
export function clientIp(request: Request): string {
  const header = request.app.get(CLIENT_IP_HEADER_SETTING) as
    string | undefined;
  const forwarded = header ? request.get(header)?.trim() : undefined;
  if (forwarded && isIP(forwarded)) return forwarded;
  return request.socket.remoteAddress ?? 'unknown';
}

export const ClientIp = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    clientIp(context.switchToHttp().getRequest<Request>()),
);
