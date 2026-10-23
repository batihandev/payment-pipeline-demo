import {
  Catch,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
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
  if ('status' in error && typeof error.status === 'number')
    return error.status;
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
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof ApiError) {
      response
        .set(error.headers)
        .status(error.getStatus())
        .json(error.getResponse());
      return;
    }
    const status = statusOf(error);
    if (status >= 400 && status < 500)
      response
        .status(status)
        .json({ error: clientErrorCodes[status] ?? 'bad_request' });
    else response.status(500).json({ error: 'internal' });
  }
}
