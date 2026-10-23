export const DAY_MS = 86_400_000;

export function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function utcDay(date: Date): Date {
  return new Date(`${utcDateKey(date)}T00:00:00Z`);
}
