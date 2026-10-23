import {
  Catch,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

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

/**
 * Answers every error that reaches Fastify's error handler, which Nest owns, with a fixed body.
 * Fastify's and Nest's defaults echo the error message, and a database error's message can
 * carry connection details. Request errors keep their 4xx status and get a code for it.
 */
@Catch()
export class GenericErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const status =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : typeof error === 'object' &&
            error !== null &&
            'getStatus' in error &&
            typeof error.getStatus === 'function'
          ? Number(error.getStatus())
          : 500;
    if (status >= 400 && status < 500)
      void reply
        .code(status)
        .send({ error: clientErrorCodes[status] ?? 'bad_request' });
    else void reply.code(500).send({ error: 'internal' });
  }
}
