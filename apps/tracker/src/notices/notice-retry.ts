/** Delivery attempts and backoff for a shop notice; `notice.attempts` counts against the cap. */
export const noticeRetryOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000, jitter: 0.5 },
} as const;
