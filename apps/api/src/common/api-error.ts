import { HttpException } from '@nestjs/common';

/**
 * A refusal with a fixed `{ error }` code. The error filter answers it as given, and any
 * other error through its status table, so only this class chooses a body.
 */
export class ApiError extends HttpException {
  constructor(
    status: number,
    code: string,
    readonly details: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super({ error: code, ...details }, status);
  }
}
