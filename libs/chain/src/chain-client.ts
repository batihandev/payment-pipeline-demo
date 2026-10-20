import type { Address, Hex } from 'viem';
export type { Address, Hex } from 'viem';
export type TransferLog = {
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  blockHash: Hex;
  from: Address;
  to: Address;
  amount: bigint;
};
export interface ChainClient {
  getHead(): Promise<{ number: bigint; hash: Hex }>;
  getFinalized(): Promise<bigint>;
  getBlockHash(n: bigint): Promise<Hex | null>;
  getTransferLogs(from: bigint, to: bigint): Promise<TransferLog[]>;
  getBalances(addr: Address): Promise<{ native: bigint; usdc: bigint }>;
  sendRawTransaction(raw: Hex): Promise<Hex>;
  getTransactionReceipt(hash: Hex): Promise<{ blockNumber: bigint } | null>;
  getNonce(addr: Address): Promise<number>;
}
export interface TransferSigner {
  signTransfer(
    from: Address,
    to: Address,
    amount: bigint,
    nonce: number,
  ): Promise<Hex>;
}
