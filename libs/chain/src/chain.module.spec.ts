import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { REDIS } from '../../redis/src';
import { ChainClient, TransferSigner } from './chain-client';
import { ChainModule } from './chain.module';
import { privateKeyToAccount } from 'viem/accounts';
import { BUYER_ADDRESS, SHOP_ADDRESS } from './wallet-addresses';
import { ViemChainClient } from './viem-client';

const key = `0x${'11'.repeat(32)}`;
const shopKey = `0x${'22'.repeat(32)}`;
const settings = {
  CHAIN_ID: 84532,
  RPC_URL: 'http://127.0.0.1:1',
  USDC_ADDRESS: `0x${'ab'.repeat(20)}`,
  RPC_COOLDOWN_MS: 1000,
  RPC_REQUESTS_PER_SECOND_BUYER: 2,
  RPC_REQUESTS_PER_SECOND_TRACKER: 1,
  RPC_REQUESTS_PER_SECOND_API: 1,
  BUYER_PRIVATE_KEY: key,
  SHOP_PRIVATE_KEY: shopKey,
  SHOP_ADDRESS: `0x${'cd'.repeat(20)}`,
};

@Global()
@Module({
  providers: [{ provide: REDIS, useValue: {} }],
  exports: [REDIS],
})
class FakeRedisModule {}

async function build(service: 'buyer' | 'tracker' | 'api') {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        isGlobal: true,
        load: [() => settings],
      }),
      FakeRedisModule,
      ChainModule.forRoot({ service }),
    ],
  }).compile();
}

it('provides the chain client and the transfer signer to the buyer', async () => {
  const module = await build('buyer');
  expect(module.get(ChainClient)).toBeInstanceOf(ViemChainClient);
  expect(module.get(TransferSigner)).toBe(module.get(ChainClient));
});

it('provides only the chain client to the tracker and the API', async () => {
  for (const service of ['tracker', 'api'] as const) {
    const module = await build(service);
    expect(module.get(ChainClient)).toBeInstanceOf(ViemChainClient);
    expect(() => module.get(TransferSigner)).toThrow();
  }
});

it('derives the buyer and shop addresses from their keys once, for the buyer only', async () => {
  const module = await build('buyer');
  expect(module.get(BUYER_ADDRESS)).toBe(
    privateKeyToAccount(key as `0x${string}`).address,
  );
  expect(module.get(SHOP_ADDRESS)).toBe(
    privateKeyToAccount(shopKey as `0x${string}`).address,
  );
  const tracker = await build('tracker');
  expect(() => {
    tracker.get(BUYER_ADDRESS);
  }).toThrow();
  expect(() => {
    tracker.get(SHOP_ADDRESS);
  }).toThrow();
});
