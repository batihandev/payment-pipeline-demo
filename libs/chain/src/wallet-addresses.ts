import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from './chain-client';

export const BUYER_ADDRESS = Symbol('BUYER_ADDRESS');
export const SHOP_ADDRESS = Symbol('SHOP_ADDRESS');

export const walletAddress = (privateKey: string): Address =>
  privateKeyToAccount(privateKey as Hex).address;
