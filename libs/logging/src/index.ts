import { ConsoleLogger } from '@nestjs/common';
import { ConfigError } from '../../config/src';

/** The logger every app runs with: one JSON object per line, without debug or verbose lines. */
export function appLogger(): ConsoleLogger {
  return new ConsoleLogger({
    json: true,
    logLevels: ['fatal', 'error', 'warn', 'log'],
  });
}

export type ErrorFields = { name?: string; code?: string };

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The parts of an error that are safe to log: its class name and its code (a Prisma,
 * Stripe, PostgreSQL or Node code such as `P1001` or `ECONNREFUSED`). Never the message or
 * the stack, which can carry connection strings, keys or request data.
 */
export function errorFields(error: unknown): ErrorFields {
  if (typeof error !== 'object' || error === null) return {};
  const fields: ErrorFields = {};
  const { name, code } = error as { name?: unknown; code?: unknown };
  if (typeof name === 'string' && SAFE_NAME.test(name)) fields.name = name;
  if (typeof code === 'string' && SAFE_CODE.test(code)) fields.code = code;
  return fields;
}

/** Logs why an app could not start: the error's name and code, and for a bad configuration the variable names. */
export function logStartupFailure(error: unknown): void {
  appLogger().fatal('Startup failed.', {
    ...errorFields(error),
    ...(error instanceof ConfigError && { variables: error.variables }),
  });
}
