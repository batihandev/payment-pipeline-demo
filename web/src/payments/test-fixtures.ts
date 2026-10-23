import type { Incident, Payment } from './types';

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
    ...overrides,
  };
}

export function incident(
  kind: string,
  paymentId: string | null = payment().id,
): Incident {
  return {
    id: `incident-${kind}`,
    kind,
    whatHappened: 'Something happened.',
    howHandled: 'It was handled.',
    paymentId,
    fromBlock: null,
    toBlock: null,
    createdAt: '2026-10-23T10:00:00.000Z',
  };
}
