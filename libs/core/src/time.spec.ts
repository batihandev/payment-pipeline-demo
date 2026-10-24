import { expect, it } from 'vitest';
import { utcDateKey, utcDay } from './time';

it('keys a date by its UTC day', () => {
  expect(utcDateKey(new Date('2026-10-20T23:59:59.999Z'))).toBe('2026-10-20');
  expect(utcDateKey(new Date('2026-10-21T00:00:00Z'))).toBe('2026-10-21');
});

it('starts a UTC day at midnight', () => {
  expect(utcDay(new Date('2026-10-20T23:59:59.999Z')).toISOString()).toBe(
    '2026-10-20T00:00:00.000Z',
  );
});
