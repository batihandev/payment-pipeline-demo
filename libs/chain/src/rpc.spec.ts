import { RpcError, classifyRpcError } from './rpc-error';
import { RpcLimiter } from './rpc-limiter';

it('spaces every RPC method through one service limiter', async () => {
  let now = 0;
  const limiter = new RpcLimiter(
    2,
    30000,
    () => now,
    async (ms) => {
      now += ms;
    },
  );
  const starts: number[] = [];
  await Promise.all(
    Array.from({ length: 4 }, () =>
      limiter.run(async () => {
        starts.push(now);
      }),
    ),
  );
  expect(starts).toEqual([0, 500, 1000, 1500]);
});

it('starts a service cooldown after a rate limit without retrying the rejected operation', async () => {
  let now = 0;
  const limiter = new RpcLimiter(
    5,
    30000,
    () => now,
    async (ms) => {
      now += ms;
    },
  );
  await expect(
    limiter.run(async () => {
      throw new RpcError('rate_limit');
    }),
  ).rejects.toMatchObject({ kind: 'rate_limit' });
  const resumed = await limiter.run(async () => now);
  expect(resumed).toBe(30000);
});

it.each([
  [{ code: 429, message: 'secret RPC URL' }, 'rate_limit'],
  [{ cause: { message: 'request timed out' } }, 'timeout'],
  [{ message: 'block range too large' }, 'range_too_large'],
  [{ code: -32602, message: 'invalid params' }, 'permanent'],
  [{ status: 503 }, 'transient'],
  [{ code: 'ECONNRESET' }, 'transient'],
] as const)(
  'classifies provider failures without exposing their contents (%j)',
  (failure, kind) => {
    const error = classifyRpcError(failure);
    expect(error.kind).toBe(kind);
    expect(error.message).toBe(`RPC request failed: ${kind}`);
  },
);
