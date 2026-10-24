import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import type { Hex } from '@app/chain/chain-client';
import { ScriptedChain } from '@testing/chain/scripted-chain';
import { OrderSenderService } from '../../buyer/src/sending/order-sender.service';
import { RedisLock } from '../../buyer/src/sending/redis-lock';
import {
  fixture,
  clear,
  TrackerChain,
  log,
  now,
  options,
  trackerConfig,
  order,
  shop,
} from '../testing/fixtures';
import { ScannerService } from './scanning/scanner.service';
import { testRedisUrl } from '@testing/config/redis';
import { fakeConfig } from '@testing/config/config';
import type { BuyerConfig } from '../../buyer/src/buyer-config';
let f: Awaited<ReturnType<typeof fixture>>;
let redis: Redis;
beforeAll(async () => {
  f = await fixture();
  redis = new Redis(testRedisUrl());
});
afterAll(async () => {
  await redis.quit();
  await f.close();
});
beforeEach(async () => {
  await clear(f.db);
  await f.db.walletNonce.deleteMany();
});
it('keeps one payment when the tracker observes a broadcast before the buyer recovers its receipt', async () => {
  const row = await order(f.db);
  const chain = new ScriptedChain();
  const sender = new OrderSenderService(
    f.db,
    chain,
    chain,
    new RedisLock(redis, 'tracker-buyer-link'),
    log().from,
    shop,
    fakeConfig<BuyerConfig>({ CHAIN_ID: options.chainId }),
  );
  chain.fail = 'after-broadcast';
  await expect(sender.sendForOrder(row.id)).rejects.toMatchObject({
    kind: 'timeout',
  });
  const sentOrder = await f.db.order.findUniqueOrThrow({
    where: { id: row.id },
  });
  const blocks = new TrackerChain();
  blocks.logs = [{ ...log(), txHash: sentOrder.transactionHash as Hex }];
  await new ScannerService(f.db, blocks, trackerConfig(), () => now).scanOnce();
  const received = await f.db.payment.findFirstOrThrow();
  chain.fail = null;
  await sender.sendForOrder(row.id);
  expect(await f.db.payment.count()).toBe(1);
  expect(await f.db.payment.findFirstOrThrow()).toMatchObject({
    id: received.id,
    stage: 'received',
    orderId: row.id,
    transactionHash: sentOrder.transactionHash,
  });
  expect(chain.accepted.size).toBe(1);
});
