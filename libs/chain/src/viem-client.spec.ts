import {
  custom,
  decodeFunctionData,
  erc20Abi,
  keccak256,
  parseTransaction,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TRANSFER_GAS_LIMIT, ViemChainClient } from './viem-client';
import { RpcLimiter } from './rpc-limiter';

const key = `0x${'11'.repeat(32)}` as const;
const buyer = privateKeyToAccount(key).address;
const shop = `0x${'22'.repeat(20)}` as const;
const token = `0x${'33'.repeat(20)}` as const;
const hash = `0x${'aa'.repeat(32)}` as const;
function client(fail = false) {
  return new ViemChainClient(
    {
      chainId: 84532,
      rpcUrl: 'http://unused.invalid',
      usdcAddress: token,
      keys: [key],
    },
    new RpcLimiter(1000000, 1),
    custom({
      request: async ({ method }) => {
        if (fail)
          throw { code: 429, message: 'https://secret.invalid/private-key' };
        if (method === 'eth_getTransactionCount') return '0x7';
        if (method === 'eth_getBalance') return '0x64';
        if (method === 'eth_call') return `0x${'0'.repeat(62)}c8`;
        if (method === 'eth_getTransactionReceipt') return null;
        if (method === 'eth_sendRawTransaction')
          throw { code: -32000, message: 'already known' };
        if (method === 'eth_gasPrice') return '0xa';
        if (method === 'eth_estimateGas') return '0x186a0';
        if (method === 'eth_getLogs') return [];
        throw new Error(`Unexpected method ${method}`);
      },
    }),
  );
}
it('reads balances as integer units and returns the pending account nonce', async () => {
  expect(await client().getBalances(buyer)).toEqual({
    native: 100n,
    usdc: 200n,
  });
  expect(await client().getNonce(buyer)).toBe(7);
});
it('signs a USDC transfer with the allocated nonce and configured chain', async () => {
  const raw = await client().signTransfer(buyer, shop, 14000731n, 7);
  const tx = parseTransaction(raw);
  expect(tx).toMatchObject({
    nonce: 7,
    chainId: 84532,
    to: token,
    gas: 100000n,
    gasPrice: 10n,
  });
  expect(
    decodeFunctionData({ abi: erc20Abi, data: tx.data ?? '0x' }),
  ).toMatchObject({ functionName: 'transfer', args: [shop, 14000731n] });
});
it('treats an already known raw transaction as its original hash', async () => {
  expect(await client().sendRawTransaction('0x1234')).toBe(keccak256('0x1234'));
});
it('returns no receipt when the transaction has not landed', async () => {
  expect(await client().getTransactionReceipt(hash)).toBeNull();
});
it('sanitizes RPC failures at the transport boundary', async () => {
  await expect(client(true).getNonce(buyer)).rejects.toMatchObject({
    kind: 'rate_limit',
    message: 'RPC request failed: rate_limit',
  });
});
it('signs three transfers within 5 s with one gas price call and no gas estimate', async () => {
  const methods: string[] = [];
  const counted = new ViemChainClient(
    {
      chainId: 84532,
      rpcUrl: 'http://unused.invalid',
      usdcAddress: token,
      keys: [key],
    },
    new RpcLimiter(1000000, 1),
    custom({
      request: async ({ method }) => {
        methods.push(method);
        if (method === 'eth_gasPrice') return '0xa';
        throw new Error(`Unexpected method ${method}`);
      },
    }),
  );
  for (const nonce of [1, 2, 3]) {
    const tx = parseTransaction(
      await counted.signTransfer(buyer, shop, 100n, nonce),
    );
    expect(tx.gas).toBe(TRANSFER_GAS_LIMIT);
  }
  expect(methods.filter((m) => m === 'eth_estimateGas')).toHaveLength(0);
  expect(methods.filter((m) => m === 'eth_gasPrice')).toHaveLength(1);
});
