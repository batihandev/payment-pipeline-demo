import { afterAll } from 'vitest';
/** Puts `process.env` back as it was when this was called once the spec file has finished. */
export function restoreEnvironmentAfterAll(): void {
  const original = { ...process.env };
  afterAll(() => {
    process.env = { ...original };
  });
}
