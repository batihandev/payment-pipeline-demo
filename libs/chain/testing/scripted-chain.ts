import { keccak256, hexToString, toHex, type Address, type Hex } from 'viem';
import type { ChainClient, TransferSigner } from '../src/chain-client';
import { RpcError } from '../src/rpc-error';
export class ScriptedChain implements ChainClient, TransferSigner {
  signed = 0;
  private readonly balances = new Map<Address, bigint>();
  accepted = new Set<Hex>();
  receipts = new Set<Hex>();
  fail:
    'sign' | 'broadcast' | 'permanent-broadcast' | 'after-broadcast' | null =
    null;
  getHead = async () => ({ number: 1n, hash: '0xaa' as Hex });
  getFinalized = async () => 0n;
  getBlockHash = async () => '0xaa' as Hex;
  getTransferLogs = async () => [];
  getBalances = async (address: Address) => ({
    native: 1n,
    usdc: this.balances.get(address) ?? 500n,
  });
  getNonce = async () => 3;
  getTransactionReceipt = async (hash: Hex) =>
    this.receipts.has(hash) ? { blockNumber: 1n } : null;
  async signTransfer(
    from: Address,
    to: Address,
    amount: bigint,
    nonce: number,
  ): Promise<Hex> {
    if (this.fail === 'sign') throw new RpcError('permanent');
    this.signed++;
    return toHex(
      JSON.stringify({
        from,
        to,
        amount: amount.toString(),
        nonce,
        signing: this.signed,
      }),
    );
  }
  async sendRawTransaction(raw: Hex): Promise<Hex> {
    if (this.fail === 'broadcast') throw new RpcError('timeout');
    if (this.fail === 'permanent-broadcast') throw new RpcError('permanent');
    const hash = keccak256(raw);
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
      throw new RpcError('timeout');
    }
    return hash;
  }
}
