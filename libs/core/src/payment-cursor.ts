/**
 * A position in the payments feed, which is sorted by `COALESCE(sent_at, received_at) DESC
 * NULLS LAST, id DESC`. `at` is that sort time (null when a payment has neither), so a page
 * read before a cursor continues exactly after the row it was made from.
 */
export type PaymentCursor = { at: string | null; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function paymentCursor(payment: {
  id: string;
  sentAt: string | null;
  receivedAt: string | null;
}): PaymentCursor {
  return { at: payment.sentAt ?? payment.receivedAt, id: payment.id };
}

/** The cursor as URL-safe base64 of its JSON. */
export function encodePaymentCursor(cursor: PaymentCursor): string {
  return btoa(JSON.stringify({ at: cursor.at, id: cursor.id }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

/** The cursor in `value`, or null when it is not one `encodePaymentCursor` could make. */
export function decodePaymentCursor(value: string): PaymentCursor | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/')));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return null;
  const { at, id } = parsed as Record<string, unknown>;
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  if (at === null) return { at, id };
  if (typeof at !== 'string' || !isIsoTime(at)) return null;
  return { at, id };
}

/** Only the exact form `Date.prototype.toISOString` writes, so an impossible date is refused. */
function isIsoTime(value: string): boolean {
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}
