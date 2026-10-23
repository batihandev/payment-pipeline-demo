/** Serves the last computed value for `ttl` ms; concurrent callers share one computation. */
export function ttlCache<T>(
  ttl: number,
  compute: () => Promise<T>,
  now: () => number,
): () => Promise<T> {
  let cache: { expires: number; value: T } | undefined;
  let loading: Promise<T> | undefined;
  return async () => {
    if (cache && now() < cache.expires) return cache.value;
    loading ??= (async () => {
      const value = await compute();
      cache = { expires: now() + ttl, value };
      return value;
    })();
    try {
      return await loading;
    } finally {
      loading = undefined;
    }
  };
}
