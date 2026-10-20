import { createHmac, timingSafeEqual } from 'node:crypto';

export function signNotice(
  body: string,
  secret: string,
  timestamp: number,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

export function verifyNotice(
  body: string,
  secret: string,
  timestamp: number,
  signature: string,
  now: number,
): boolean {
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    !Number.isSafeInteger(now) ||
    now < timestamp ||
    now - timestamp > 300 ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return false;
  return timingSafeEqual(
    Buffer.from(signNotice(body, secret, timestamp), 'hex'),
    Buffer.from(signature, 'hex'),
  );
}
