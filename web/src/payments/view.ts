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
export const cardSteps = [
  {
    stage: 'sent',
    label: 'Sent',
    hint: 'Charge sent to the test card',
    color: 'blue',
  },
  {
    stage: 'processing',
    label: 'Processing',
    hint: 'Stripe is processing the charge',
    color: 'orange',
  },
  steps[2],
  steps[3],
] as const;
export type Step = {
  stage: Payment['stage'];
  label: string;
  hint: string;
  color: string;
};
export function stepsFor(provider: Payment['provider']): readonly Step[] {
  return provider === 'stripe' ? cardSteps : steps;
}
export type CardRail = 'checking' | 'available' | 'unavailable';
/** Whether the card rail can be offered; "checking" until the first /health read arrives. */
export function cardRail(
  health: Pick<Health, 'cardAvailable'> | null,
): CardRail {
  if (!health) return 'checking';
  return health.cardAvailable === true ? 'available' : 'unavailable';
}
const brandNames: Record<string, string> = {
  amex: 'American Express',
  diners: 'Diners Club',
  jcb: 'JCB',
  mastercard: 'Mastercard',
  unionpay: 'UnionPay',
};
export function cardBrandName(brand: string): string {
  return brandNames[brand] ?? brand.charAt(0).toUpperCase() + brand.slice(1);
}
/** "Visa ····4242", or null while the order's card is unknown. */
export function cardLabel(payment: Pick<Payment, 'order'>): string | null {
  const card = payment.order?.customer;
  return card?.cardBrand && card.cardLast4
    ? `${cardBrandName(card.cardBrand)} ····${card.cardLast4}`
    : null;
}
export function railBadge(
  payment: Pick<Payment, 'provider' | 'order'>,
): string {
  if (payment.provider !== 'stripe') return 'Test network';
  const card = cardLabel(payment);
  return card ? `Test card · ${card}` : 'Test card';
}
export function confirmationLabel(
  confirmations: number,
  threshold: number,
): string {
  return confirmations < threshold
    ? `${confirmations} of ${threshold}`
    : `${threshold}+ confirmations`;
}
/** Every stage step a payment on either rail can reach, in order, for the pipeline lanes. */
export const pipelineSteps: readonly Step[] = [
  steps[0],
  steps[1],
  cardSteps[1],
  steps[2],
  steps[3],
];
type StagePayment = Pick<Payment, 'stage' | 'confirmations' | 'final'> &
  Partial<Pick<Payment, 'provider'>>;
type StageView = {
  label: string;
  step: number;
  color: string;
  paid: boolean;
  final: boolean;
};
/** The stage of a payment; with a confirmation threshold, also its confirmation progress. */
export function stageView(payment: StagePayment): StageView;
export function stageView(
  payment: StagePayment,
  threshold: number,
): StageView & { progress: number; confirmationLabel: string };
export function stageView(payment: StagePayment, threshold?: number) {
  const stages = stepsFor(payment.provider ?? 'chain');
  const step = stages.findIndex((s) => s.stage === payment.stage);
  const view: StageView = {
    label:
      payment.stage === 'sent'
        ? 'Sent'
        : payment.stage === 'processing'
          ? 'Processing'
          : (stages[step]?.label ?? payment.stage),
    step,
    color: stages[step]?.color ?? 'blue',
    paid: payment.stage === 'settled' || payment.stage === 'notified',
    final: payment.final,
  };
  if (threshold === undefined) return view;
  return {
    ...view,
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
  if (status === 503 && error === 'card_unavailable')
    return 'Test card payments are unavailable right now. Try the test network.';
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
