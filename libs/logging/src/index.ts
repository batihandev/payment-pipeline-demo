import { ConsoleLogger } from '@nestjs/common';
import { ConfigError } from '../../config/src';

const STACK_TRACE = /^Error\b[^\n]*\n|\n {4}at /;

/** True for the stack text Nest passes next to an error: several lines, starting `Error` or with `    at` frames. */
function looksLikeStack(value: unknown): boolean {
  return (
    typeof value === 'string' && value.includes('\n') && STACK_TRACE.test(value)
  );
}

/**
 * Nest's own error calls pass raw errors and their stacks to the logger (a failed
 * provider, a rejected shutdown hook, a failed shutdown). This keeps only each error's
 * name and code, and drops stack text, so no call site can print a message or a stack.
 */
function withoutErrorDetail(args: unknown[]): unknown[] {
  return args.flatMap((arg, index) => {
    if (arg instanceof Error)
      return index === 0
        ? ['Unhandled error.', errorFields(arg)]
        : [errorFields(arg)];
    return looksLikeStack(arg) ? [] : [arg];
  });
}

class AppLogger extends ConsoleLogger {
  override log(message: unknown, ...rest: unknown[]): void {
    const [first, ...others] = withoutErrorDetail([message, ...rest]);
    super.log(first, ...others);
  }
  override error(message: unknown, ...rest: unknown[]): void {
    const [first, ...others] = withoutErrorDetail([message, ...rest]);
    super.error(first, ...others);
  }
  override warn(message: unknown, ...rest: unknown[]): void {
    const [first, ...others] = withoutErrorDetail([message, ...rest]);
    super.warn(first, ...others);
  }
  override fatal(message: unknown, ...rest: unknown[]): void {
    const [first, ...others] = withoutErrorDetail([message, ...rest]);
    super.fatal(first, ...others);
  }
}

/** The logger every app runs with: one JSON object per line, without debug or verbose lines, and no error message or stack. */
export function appLogger(): ConsoleLogger {
  return new AppLogger({
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
