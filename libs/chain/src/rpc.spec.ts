import { HttpRequestError, RpcRequestError, TimeoutError } from 'viem';
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

const body = {
  method: 'eth_getLogs',
  // The USDC address contains "538" and "5426": digits that must not read as HTTP statuses.
  params: [
    {
      address: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      fromBlock: '0x2e72ffd',
    },
  ],
};
const url = 'https://rpc.example';

it.each([
  [
    new RpcRequestError({
      body,
      url,
      error: { code: -32614, message: 'eth_getLogs is limited to a 200 range' },
    }),
    'range_too_large',
  ],
  [
    new RpcRequestError({
      body,
      url,
      error: { code: -32602, message: 'invalid params' },
    }),
    'permanent',
  ],
  [new HttpRequestError({ body, url, status: 429 }), 'rate_limit'],
  [new HttpRequestError({ body, url, status: 502 }), 'transient'],
  [
    new HttpRequestError({ body, url, status: 400, details: 'bad request' }),
    'permanent',
  ],
  [new TimeoutError({ body, url }), 'timeout'],
] as const)(
  'classifies viem errors by their fields, not the request they carry (%#)',
  (failure, kind) => {
    expect(classifyRpcError(failure).kind).toBe(kind);
  },
);
