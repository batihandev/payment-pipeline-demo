import type { Health, Payment } from './types';

/** The spec's default confirmation count, used until the first /health read arrives. */
const DEFAULT_CONFIRMATIONS = 10;
export function confirmationsNeeded(health: Health | null): number {
  return health?.confirmations ?? DEFAULT_CONFIRMATIONS;
}

export const steps = [
  {
    stage: 'received',
    label: 'Received',
    hint: 'Payment spotted in a new block',
    color: 'blue',
  },
  {
    stage: 'confirming',
    label: 'Confirming',
    hint: 'Waiting for confirmations',
    color: 'orange',
  },
  {
    stage: 'settled',
    label: 'Settled',
    hint: 'Credited once, ledger written',
    color: 'green',
  },
  {
    stage: 'notified',
    label: 'Shop notified',
    hint: 'The shop accepted the signed notice',
    color: 'purple',
  },
] as const;
export function confirmationLabel(
  confirmations: number,
  threshold: number,
): string {
  return confirmations < threshold
    ? `${confirmations} of ${threshold}`
    : `${threshold}+ confirmations`;
}
export function stageView(
  payment: Pick<Payment, 'stage' | 'confirmations' | 'final'>,
  threshold: number,
) {
  const step = steps.findIndex((s) => s.stage === payment.stage);
  return {
    label:
      payment.stage === 'sent'
        ? 'Sent'
        : payment.stage === 'processing'
          ? 'Processing'
          : (steps[step]?.label ?? payment.stage),
    step,
    color: steps[step]?.color ?? 'blue',
    paid: payment.stage === 'settled' || payment.stage === 'notified',
    final: payment.final,
    progress: Math.min(1, Math.max(0, payment.confirmations / threshold)),
    confirmationLabel: confirmationLabel(payment.confirmations, threshold),
  };
}
export function isVisitorOrder(
  payment: Pick<Payment, 'orderId'>,
  visitorOrders: ReadonlySet<string>,
): boolean {
  return payment.orderId !== null && visitorOrders.has(payment.orderId);
}
export function money(value: string): string {
  const units = BigInt(value);
  return `$${units / 1000000n}.${((units % 1000000n) / 10000n).toString().padStart(2, '0')}`;
}
export function purchaseMessage(
  status: number,
  error: string | undefined,
  retryAfter: string | null,
): string {
  if (status === 429 && error === 'rate_limited') {
    const seconds = Number(retryAfter);
    return Number.isFinite(seconds) && seconds > 0
      ? `You've made a lot of test purchases. Try again in ${Math.ceil(seconds)} seconds.`
      : "You've made a lot of test purchases. Try again shortly.";
  }
  if (status === 429 && error === 'busy')
    return 'Lots of test purchases right now. Try again in a moment.';
  if (status === 409 && error === 'daily_limit')
    return "Today's test purchases are used up. Back at 00:00 UTC.";
  if (status === 503 && error === 'paused')
    return 'The demo account is being topped up. Try again soon.';
  return 'Demo offline';
}
export function shortId(id: string): string {
  return id.slice(0, 8);
}
export function utcTime(time: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(time));
}
