export const QUEUES = {
  buyer: 'buyer',
  buyerUpkeep: 'buyer-upkeep',
  tracker: 'tracker',
  shopNotices: 'shop-notices',
} as const;

export const JOBS = {
  buyer: {
    paceMinute: 'pace-minute',
    retention: 'retention',
    visitorPurchase: 'visitor-purchase',
    sendOrder: 'send-order',
  },
  buyerUpkeep: {
    refillCheck: 'refill-check',
    checkUnseen: 'check-unseen',
    expireOrders: 'expire-orders',
    nightlySweep: 'nightly-sweep',
  },
  tracker: {
    retryGap: 'retry-gap',
    deliverPayments: 'deliver-payments',
  },
  shopNotices: {
    shopNotice: 'shop-notice',
  },
} as const;

export const retryOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000, jitter: 0.5 },
} as const;

const keepFinished = { removeOnComplete: 100, removeOnFail: 100 } as const;

export function schedulerJobOptions({
  priority,
  retry = true,
}: { priority?: number; retry?: boolean } = {}) {
  return {
    ...(retry ? retryOptions : {}),
    ...(priority === undefined ? {} : { priority }),
    ...keepFinished,
  };
}
