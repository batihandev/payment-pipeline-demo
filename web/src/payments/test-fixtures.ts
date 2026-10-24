import type { Health, Payment } from './types';

type Order = NonNullable<Payment['order']>;

export function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: '5f0c1c9e-0000-4000-8000-000000000001',
    provider: 'chain',
    externalKey: 'key',
    orderId: null,
    amount: '50000',
    stage: 'settled',
    confirmations: 7,
    chainId: 84532,
    blockNumber: '100',
    receiptUrl: null,
    blockHash: null,
    transactionHash: null,
    logIndex: null,
    donation: false,
    final: false,
    sentAt: null,
    receivedAt: '2026-10-23T10:00:00.000Z',
    confirmingAt: null,
    processingAt: null,
    settledAt: null,
    notifiedAt: null,
    finalAt: null,
    donorName: null,
    noteKinds: [],
    explorerUrl: null,
    version: 0,
    ...overrides,
  };
}

export function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    item: 'Duck',
    price: '500000',
    expectedAmount: '500000',
    status: 'open',
    source: 'visitor',
    createdAt: '2026-10-23T10:00:00.000Z',
    expiresAt: '2026-10-23T10:30:00.000Z',
    customer: null,
    ...overrides,
  };
}

export function health(overrides: Partial<Health> = {}): Health {
  return {
    confirmations: 10,
    head: '100',
    cursor: '100',
    lag: '0',
    openGaps: 0,
    queueDepth: null,
    cooldowns: null,
    balances: null,
    chainError: null,
    cardAvailable: false,
    redisError: null,
    monitoring: {
      cursorAdvancedAt: null,
      oldestUnsettledAt: null,
      oldestUnnotifiedAt: null,
      lastScheduledPurchaseAt: null,
      lastCardSettledAt: null,
      visitorPausedSince: null,
    },
    ...overrides,
  };
}
