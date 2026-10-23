import { bigintReplacer } from '../../../../libs/core/src/json';

export function json(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, bigintReplacer));
}
