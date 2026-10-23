import {
  Catch,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ApiError } from './api-error';

const clientErrorCodes: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
};

function statusOf(error: unknown): number {
  if (typeof error !== 'object' || error === null) return 500;
  if ('statusCode' in error && typeof error.statusCode === 'number')
    return error.statusCode;
  if ('getStatus' in error && typeof error.getStatus === 'function')
    return Number(error.getStatus());
  return 500;
}

/**
 * Answers every error that reaches the HTTP adapter with a fixed body. The adapters' and
 * Nest's defaults echo the error message, and a database error's message can carry
 * connection details. Request errors keep their 4xx status and get a code for it; an
 * `ApiError` keeps the code its route chose.
 */
@Catch()
export class GenericErrorFilter implements ExceptionFilter {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const response = host.switchToHttp().getResponse();
    if (error instanceof ApiError) {
      for (const [name, value] of Object.entries(error.headers))
        httpAdapter.setHeader(response, name, value);
      httpAdapter.reply(response, error.getResponse(), error.getStatus());
      return;
    }
    const status = statusOf(error);
    if (status >= 400 && status < 500)
      httpAdapter.reply(
        response,
        { error: clientErrorCodes[status] ?? 'bad_request' },
        status,
      );
    else httpAdapter.reply(response, { error: 'internal' }, 500);
  }
}
