import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from './chain-client';

export const walletAddress = (privateKey: string): Address =>
  privateKeyToAccount(privateKey as Hex).address;
