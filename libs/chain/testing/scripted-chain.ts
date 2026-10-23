import { keccak256, hexToString, toHex, type Address, type Hex } from 'viem';
import type { ChainClient, TransferSigner } from '../src/chain-client';
import { RpcError } from '../src/rpc-error';
export class ScriptedChain implements ChainClient, TransferSigner {
  signed = 0;
  calls: string[] = [];
  nonce = 3;
  signedNonces: number[] = [];
  private readonly balances = new Map<Address, bigint>();
  accepted = new Set<Hex>();
  receipts = new Set<Hex>();
  reverted = new Set<Hex>();
  fail:
    'sign' | 'broadcast' | 'permanent-broadcast' | 'after-broadcast' | null =
    null;
  getHead = () => Promise.resolve({ number: 1n, hash: '0xaa' as const });
  getFinalized = () => Promise.resolve(0n);
  getBlockHash = () => Promise.resolve('0xaa' as Hex);
  getTransferLogs = () => Promise.resolve([]);
  getBalances = (address: Address) =>
    Promise.resolve({
      native: 1n,
      usdc: this.balances.get(address) ?? 500n,
    });
  getNonce = () => {
    this.calls.push('getNonce');
    return Promise.resolve(this.nonce);
  };
  getConfirmedNonce = () => {
    this.calls.push('getConfirmedNonce');
    return Promise.resolve(this.nonce);
  };
  getTransactionReceipt = (hash: Hex) => {
    this.calls.push('getTransactionReceipt');
    if (this.reverted.has(hash))
      return Promise.resolve({ blockNumber: 1n, status: 'reverted' as const });
    return Promise.resolve(
      this.receipts.has(hash)
        ? { blockNumber: 1n, status: 'success' as const }
        : null,
    );
  };
  signTransfer(
    from: Address,
    to: Address,
    amount: bigint,
    nonce: number,
  ): Promise<Hex> {
    if (this.fail === 'sign') return Promise.reject(new RpcError('permanent'));
    this.signed++;
    this.signedNonces.push(nonce);
    return Promise.resolve(
      toHex(
        JSON.stringify({
          from,
          to,
          amount: amount.toString(),
          nonce,
          signing: this.signed,
        }),
      ),
    );
  }
  sendRawTransaction(raw: Hex): Promise<Hex> {
    this.calls.push('sendRawTransaction');
    if (this.fail === 'broadcast')
      return Promise.reject(new RpcError('timeout'));
    if (this.fail === 'permanent-broadcast')
      return Promise.reject(new RpcError('permanent'));
    const hash = keccak256(raw);
    if (
      !this.accepted.has(hash) &&
      (JSON.parse(hexToString(raw)) as { nonce: number }).nonce < this.nonce
    )
      return Promise.reject(new RpcError('nonce_too_low'));
    if (!this.accepted.has(hash)) {
      const transfer = JSON.parse(hexToString(raw)) as {
        from: Address;
        to: Address;
        amount: string;
      };
      const amount = BigInt(transfer.amount);
      this.balances.set(
        transfer.from,
        (this.balances.get(transfer.from) ?? 500n) - amount,
      );
      this.balances.set(
        transfer.to,
        (this.balances.get(transfer.to) ?? 500n) + amount,
      );
      this.accepted.add(hash);
    }
    if (this.fail === 'after-broadcast') {
      this.receipts.add(hash);
      return Promise.reject(new RpcError('timeout'));
    }
    return Promise.resolve(hash);
  }
}
