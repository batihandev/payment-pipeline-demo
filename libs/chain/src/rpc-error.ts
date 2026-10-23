import { BaseError, TimeoutError } from 'viem';

export type RpcErrorKind =
  | 'rate_limit'
  | 'timeout'
  | 'range_too_large'
  | 'nonce_too_low'
  | 'transient'
  | 'permanent';
export class RpcError extends Error {
  constructor(
    readonly kind: RpcErrorKind,
    detail?: string,
  ) {
    super(`RPC request failed: ${kind}${detail ? ` (${detail})` : ''}`);
  }
}

// Each level of the cause chain: the provider's own words, plus numeric HTTP statuses and RPC
// codes. A viem error's message also embeds the request body (addresses, block numbers), so
// only its shortMessage and details are read.
function chain(error: unknown): { text: string[]; codes: number[] } {
  const seen = new Set<unknown>();
  const text: string[] = [];
  const codes: number[] = [];
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const textKeys =
      error instanceof BaseError
        ? ['shortMessage', 'details']
        : ['message', 'details'];
    for (const key of textKeys) {
      const value = Reflect.get(error, key);
      if (typeof value === 'string') text.push(value);
    }
    for (const key of ['code', 'status']) {
      const value = Reflect.get(error, key);
      if (typeof value === 'number') codes.push(value);
      else if (typeof value === 'string') text.push(value);
    }
    error = Reflect.get(error, 'cause');
  }
  return { text, codes };
}

export function errorDetails(error: unknown): string {
  return chain(error).text.join(' ').toLowerCase();
}

export function classifyRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  if (
    error instanceof BaseError &&
    error.walk((e) => e instanceof TimeoutError)
  )
    return new RpcError('timeout');
  const { codes } = chain(error);
  const details = errorDetails(error);
  const kind: RpcErrorKind =
    codes.includes(429) || /rate.?limit|too many requests/.test(details)
      ? 'rate_limit'
      : /timeout|timed out|etimedout/.test(details)
        ? 'timeout'
        : /range.*(large|wide)|too many (results|blocks)|response size|limited to (a )?\d+ range/.test(
              details,
            )
          ? 'range_too_large'
          : /nonce too low|nonce is too low|already been used/.test(details)
            ? 'nonce_too_low'
            : codes.some((code) => code >= 500 && code <= 599) ||
                /econnreset|econnrefused|socket|network|fetch failed|temporar/.test(
                  details,
                )
              ? 'transient'
              : 'permanent';
  return new RpcError(kind);
}
