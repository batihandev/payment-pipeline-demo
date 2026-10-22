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
export type TransactionReceipt = {
  blockNumber: bigint;
  status: 'success' | 'reverted';
};
export interface ChainClient {
  getHead(): Promise<{ number: bigint; hash: Hex }>;
  getFinalized(): Promise<bigint>;
  getBlockHash(n: bigint): Promise<Hex | null>;
  getTransferLogs(from: bigint, to: bigint): Promise<TransferLog[]>;
  getBalances(addr: Address): Promise<{ native: bigint; usdc: bigint }>;
  sendRawTransaction(raw: Hex): Promise<Hex>;
  getTransactionReceipt(hash: Hex): Promise<TransactionReceipt | null>;
  /** Next nonce counting the transactions waiting in the mempool. */
  getNonce(addr: Address): Promise<number>;
  /** Next nonce counting only mined transactions. */
  getConfirmedNonce(addr: Address): Promise<number>;
}
export interface TransferSigner {
  signTransfer(
    from: Address,
    to: Address,
    amount: bigint,
    nonce: number,
  ): Promise<Hex>;
}
