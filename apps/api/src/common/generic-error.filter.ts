import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Request } from 'express';
import { errorFields } from '@app/logging';
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
  if (error instanceof HttpException) return error.getStatus();
  return 500;
}

/** The matched route's method and pattern, such as `GET /payments/:id`, never the URL. */
function routeOf(request: Request): string | undefined {
  const route: unknown = request.route;
  const path =
    typeof route === 'object' && route !== null && 'path' in route
      ? route.path
      : undefined;
  return typeof path === 'string' ? `${request.method} ${path}` : undefined;
}

/**
 * Answers every error that reaches the HTTP adapter with a fixed body. The adapters' and
 * Nest's defaults echo the error message, and a database error's message can carry
 * connection details. Request errors keep their 4xx status and get a code for it; an
 * `ApiError` keeps the code its route chose. An error after the headers went out, such as
 * one in a started event stream, only ends the response. A server error is logged with its
 * name, code, status and route, and never its message.
 */
@Catch()
export class GenericErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(GenericErrorFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const http = host.switchToHttp();
    const response: unknown = http.getResponse();
    const route = routeOf(http.getRequest<Request>());
    if (httpAdapter.isHeadersSent(response)) {
      this.logger.error('Request failed after its response started.', {
        ...errorFields(error),
        route,
      });
      httpAdapter.end(response);
      return;
    }
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
    else {
      this.logger.error('Request failed.', {
        ...errorFields(error),
        status: 500,
        route,
      });
      httpAdapter.reply(response, { error: 'internal' }, 500);
    }
  }
}
