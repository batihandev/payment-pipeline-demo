import type { ConfigService } from '@nestjs/config';

/** A `ConfigService` that answers from `values`, for specs that construct a service directly. */
export function fakeConfig<T extends object>(
  values: Partial<T>,
): ConfigService<T, true> {
  return {
    get: (key: keyof T) => values[key],
  } as unknown as ConfigService<T, true>;
}
