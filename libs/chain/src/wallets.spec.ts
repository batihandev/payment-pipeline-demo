import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { createWallets } from '../../../scripts/wallets-new';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wallet-test-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('writes two usable keys privately and returns only their public addresses', async () => {
  const path = join(directory, '.env');
  const addresses = await createWallets(path);
  const text = await readFile(path, 'utf8');
  for (const name of ['BUYER', 'SHOP'] as const) {
    const key = text.match(
      new RegExp(`^${name}_PRIVATE_KEY=(0x[0-9a-f]{64})$`, 'm'),
    )?.[1];
    expect(key).toBeDefined();
    expect(addresses[name]).toBe(
      privateKeyToAccount(key as `0x${string}`).address,
    );
    expect(JSON.stringify(addresses)).not.toContain(key);
  }
  expect(addresses.BUYER).not.toBe(addresses.SHOP);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it('keeps existing keys and settings while filling empty wallet settings on repeated runs', async () => {
  const path = join(directory, '.env');
  const key = `0x${'11'.repeat(32)}`;
  await writeFile(
    path,
    `RPC_URL=https://example.com\nBUYER_PRIVATE_KEY=${key}\nSHOP_PRIVATE_KEY=\nBUYER_ADDRESS=\nSHOP_ADDRESS=\n`,
  );
  const first = await createWallets(path);
  const contents = await readFile(path, 'utf8');
  expect(contents).toContain(`BUYER_PRIVATE_KEY=${key}\n`);
  expect(contents).toContain('RPC_URL=https://example.com\n');
  expect(contents).toContain(`BUYER_ADDRESS=${first.BUYER}\n`);
  expect(await createWallets(path)).toEqual(first);
  expect(await readFile(path, 'utf8')).toBe(contents);
});
