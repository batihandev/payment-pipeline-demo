import {
  BlockNotFoundError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  parseAbiItem,
  type Address,
  type Hex,
  type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChainClient, TransferLog, TransferSigner } from './chain-client';
import { classifyRpcError, errorDetails, RpcError } from './rpc-error';
import { RpcLimiter } from './rpc-limiter';

type Options = {
  chainId: number;
  rpcUrl: string;
  usdcAddress: Address;
  shopAddress?: Address;
  keys?: Hex[];
};
export const TRANSFER_GAS_LIMIT = 100_000n;
const GAS_PRICE_TTL_MS = 5000;
export class ViemChainClient implements ChainClient, TransferSigner {
  private readonly client;
  private readonly accounts;
  private gasPrice: { at: number; value: Promise<bigint> } | null = null;
  constructor(
    private readonly options: Options,
    private readonly limiter: RpcLimiter,
    transport?: Transport,
  ) {
    this.client = createPublicClient({
      chain: defineChain({
        id: options.chainId,
        name: 'Test network',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [options.rpcUrl] } },
      }),
      transport:
        transport ?? http(options.rpcUrl, { retryCount: 0, timeout: 10000 }),
    });
    this.accounts = (options.keys ?? []).map((key) => privateKeyToAccount(key));
  }
  private call<T>(operation: () => Promise<T>): Promise<T> {
    return this.limiter.run(async () => {
      try {
        return await operation();
      } catch (error) {
        throw classifyRpcError(error);
      }
    });
  }
  getHead(): Promise<{ number: bigint; hash: Hex }> {
    return this.call(async () => {
      const block = await this.client.getBlock({ blockTag: 'latest' });
      if (block.number === null || block.hash === null)
        throw new RpcError('transient');
      return { number: block.number, hash: block.hash };
    });
  }
  getFinalized(): Promise<bigint> {
    return this.call(async () => {
      const block = await this.client.getBlock({ blockTag: 'finalized' });
      if (block.number === null) throw new RpcError('transient');
      return block.number;
    });
  }
  getBlockHash(n: bigint): Promise<Hex | null> {
    return this.call(async () => {
      try {
        return (await this.client.getBlock({ blockNumber: n })).hash;
      } catch (error) {
        if (error instanceof BlockNotFoundError) return null;
        throw error;
      }
    });
  }
  getTransferLogs(from: bigint, to: bigint): Promise<TransferLog[]> {
    return this.call(async () => {
      const logs = await this.client.getLogs({
        address: this.options.usdcAddress,
        event: parseAbiItem(
          'event Transfer(address indexed from, address indexed to, uint256 value)',
        ),
        args: this.options.shopAddress
          ? { to: this.options.shopAddress }
          : undefined,
        fromBlock: from,
        toBlock: to,
        strict: true,
      });
      return logs.map((log) => ({
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        from: log.args.from,
        to: log.args.to,
        amount: log.args.value,
      }));
    });
  }
  async getBalances(addr: Address): Promise<{ native: bigint; usdc: bigint }> {
    const native = await this.call(() =>
      this.client.getBalance({ address: addr }),
    );
    const usdc = await this.call(() =>
      this.client.readContract({
        address: this.options.usdcAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [addr],
      }),
    );
    return { native, usdc };
  }
  sendRawTransaction(raw: Hex): Promise<Hex> {
    return this.call(async () => {
      try {
        return await this.client.sendRawTransaction({
          serializedTransaction: raw,
        });
      } catch (error) {
        if (/already known|known transaction/.test(errorDetails(error)))
          return keccak256(raw);
        throw error;
      }
    });
  }
  getTransactionReceipt(hash: Hex): Promise<{ blockNumber: bigint } | null> {
    return this.call(async () => {
      try {
        return {
          blockNumber: (await this.client.getTransactionReceipt({ hash }))
            .blockNumber,
        };
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    });
  }
  getNonce(addr: Address): Promise<number> {
    return this.call(() =>
      this.client.getTransactionCount({ address: addr, blockTag: 'pending' }),
    );
  }
  private cachedGasPrice(): Promise<bigint> {
    const now = Date.now();
    if (this.gasPrice && now - this.gasPrice.at < GAS_PRICE_TTL_MS)
      return this.gasPrice.value;
    const value = this.call(() => this.client.getGasPrice());
    const entry = { at: now, value };
    this.gasPrice = entry;
    value.catch(() => {
      if (this.gasPrice === entry) this.gasPrice = null;
    });
    return value;
  }
  getConfirmedNonce(addr: Address): Promise<number> {
    return this.call(() =>
      this.client.getTransactionCount({ address: addr, blockTag: 'latest' }),
    );
  }
  async signTransfer(
    from: Address,
    to: Address,
    amount: bigint,
    nonce: number,
  ): Promise<Hex> {
    const account = this.accounts.find(
      (account) => account.address.toLowerCase() === from.toLowerCase(),
    );
    if (!account) throw new RpcError('permanent');
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to, amount],
    });
    const gasPrice = await this.cachedGasPrice();
    return account.signTransaction({
      chainId: this.options.chainId,
      to: this.options.usdcAddress,
      data,
      nonce,
      gas: TRANSFER_GAS_LIMIT,
      gasPrice,
      type: 'legacy',
    });
  }
}
