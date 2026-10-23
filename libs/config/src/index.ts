import { z } from 'zod';

const positiveInteger = z.coerce.number().int().positive();
const microUnits = z.string().regex(/^\d+$/).transform(BigInt);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const connection = {
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
};
const chain = {
  CHAIN_ID: positiveInteger,
  RPC_URL: z.url({ protocol: /^https?$/ }),
  USDC_ADDRESS: address,
  RPC_COOLDOWN_MS: positiveInteger.default(30_000),
};

const confirmations = { CONFIRMATIONS: positiveInteger.default(30) };

const retention = { RETENTION_DAYS: positiveInteger.default(30) };

const purchase = {
  DAILY_COUNT_CAP: positiveInteger.default(100),
  DAILY_AMOUNT_CAP: microUnits.default(200_000_000n),
  ORDER_TTL_MINUTES: positiveInteger.default(30),
  QUIET_START_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(0),
  QUIET_END_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(7),
};

export const buyerSchema = z.object({
  ...connection,
  ...chain,
  BUYER_PRIVATE_KEY: privateKey,
  SHOP_PRIVATE_KEY: privateKey,
  ...purchase,
  ...retention,
  MAX_IN_FLIGHT: positiveInteger.default(10),
  REFILL_BELOW: microUnits.default(5_000_000n),
  REFILL_COOLDOWN_SECONDS: positiveInteger.default(20),
  RPC_REQUESTS_PER_SECOND_BUYER: positiveInteger.default(2),
});

export const trackerSchema = z.object({
  ...connection,
  ...chain,
  BUYER_ADDRESS: address,
  SHOP_ADDRESS: address,
  NOTICE_SECRET: z.string().min(32),
  SHOP_NOTICE_URL: z.url({ protocol: /^https?$/ }),
  ...confirmations,
  START_BLOCK: z.preprocess(
    (value) => (value === '' ? undefined : value),
    microUnits.optional(),
  ),
  RESCAN_BLOCKS: positiveInteger.default(5),
  MAX_RANGE: positiveInteger.default(500),
  MIN_RANGE: positiveInteger.default(10),
  ACTIVE_POLL_MS: positiveInteger.default(2000),
  IDLE_POLL_MS: positiveInteger.default(30_000),
  RPC_MAX_ATTEMPTS: positiveInteger.default(3),
  GAP_MAX_ATTEMPTS: positiveInteger.default(5),
  RPC_REQUESTS_PER_SECOND_TRACKER: positiveInteger.default(2),
});

export const apiSchema = z.object({
  ...confirmations,
  ...purchase,
  ...connection,
  ...chain,
  ...retention,
  API_PORT: positiveInteger.max(65535).default(3000),
  BUYER_ADDRESS: address,
  SHOP_ADDRESS: address,
  NOTICE_SECRET: z.string().min(32),
  WEB_ORIGIN: z.url({ protocol: /^https?$/ }),
  BLOCK_EXPLORER_URL: z
    .url({ protocol: /^https?$/ })
    .default('https://sepolia.basescan.org'),
  LOW_NATIVE_BALANCE: microUnits.default(1_000_000_000_000_000n),
  LOW_USDC_BALANCE: microUnits.default(10_000_000n),
  API_REQUESTS_PER_MINUTE: positiveInteger.default(300),
  STREAMS_PER_IP: positiveInteger.default(5),
  STREAMS_TOTAL: positiveInteger.default(500),
  VISITOR_PER_MINUTE: positiveInteger.default(10),
  VISITOR_PER_DAY: positiveInteger.default(100),
  VISITOR_QUEUE_LIMIT: positiveInteger.default(30),
  VISITOR_DAILY_LIMIT: positiveInteger.default(2000),
  DONATION_MIN: microUnits.default(10_000n),
  GAS_FLOOR: microUnits.default(200_000_000_000_000n),
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  RPC_REQUESTS_PER_SECOND_API: positiveInteger.default(1),
});

export function validateConfig<T extends z.ZodType>(
  schema: T,
  environment: Record<string, string | undefined>,
): z.output<T> {
  const result = schema.safeParse(environment);
  if (!result.success) {
    const names = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ];
    throw new Error(
      `Invalid or missing environment variables: ${names.join(', ')}`,
    );
  }
  return result.data;
}
