export type RpcErrorKind =
  'rate_limit' | 'timeout' | 'range_too_large' | 'transient' | 'permanent';
export class RpcError extends Error {
  constructor(readonly kind: RpcErrorKind) {
    super(`RPC request failed: ${kind}`);
  }
}

export function errorDetails(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    for (const key of ['message', 'details', 'code', 'status']) {
      const value = Reflect.get(error, key);
      if (typeof value === 'string' || typeof value === 'number')
        parts.push(String(value));
    }
    error = Reflect.get(error, 'cause');
  }
  return parts.join(' ').toLowerCase();
}

export function classifyRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  const details = errorDetails(error);
  const kind: RpcErrorKind = /429|rate.?limit|too many requests/.test(details)
    ? 'rate_limit'
    : /timeout|timed out|etimedout/.test(details)
      ? 'timeout'
      : /range.*(large|wide)|too many (results|blocks)|response size/.test(
            details,
          )
        ? 'range_too_large'
        : /5\d\d|econnreset|econnrefused|socket|network|fetch failed|temporar/.test(
              details,
            )
          ? 'transient'
          : 'permanent';
  return new RpcError(kind);
}
