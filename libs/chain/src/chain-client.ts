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
export abstract class ChainClient {
  abstract getHead(): Promise<{ number: bigint; hash: Hex }>;
  abstract getFinalized(): Promise<bigint>;
  abstract getBlockHash(n: bigint): Promise<Hex | null>;
  abstract getTransferLogs(from: bigint, to: bigint): Promise<TransferLog[]>;
  abstract getBalances(
    addr: Address,
  ): Promise<{ native: bigint; usdc: bigint }>;
  abstract sendRawTransaction(raw: Hex): Promise<Hex>;
  abstract getTransactionReceipt(hash: Hex): Promise<TransactionReceipt | null>;
  /** Next nonce counting the transactions waiting in the mempool. */
  abstract getNonce(addr: Address): Promise<number>;
  /** Next nonce counting only mined transactions. */
  abstract getConfirmedNonce(addr: Address): Promise<number>;
}
export abstract class TransferSigner {
  abstract signTransfer(
    from: Address,
    to: Address,
    amount: bigint,
    nonce: number,
  ): Promise<Hex>;
}
