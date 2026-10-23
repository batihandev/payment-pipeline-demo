import { ConfigError } from '../../config/src';
import { errorFields, logStartupFailure } from './index';

it('keeps only the name and code of an error, and only when they look like identifiers', () => {
  const error = Object.assign(new Error('postgresql://user:secret@db'), {
    code: 'P1001',
  });
  expect(errorFields(error)).toEqual({ name: 'Error', code: 'P1001' });
  const leaky = Object.assign(new Error('x'), {
    code: 'key=sk_test_secret value',
  });
  leaky.name = 'postgresql://user:secret@db';
  expect(errorFields(leaky)).toEqual({});
  expect(errorFields('a thrown string')).toEqual({});
});

it('logs a startup failure as one JSON line naming the bad variables, not their values', () => {
  const output = jest
    .spyOn(process.stderr, 'write')
    .mockImplementation(() => true);
  let written: string[];
  try {
    logStartupFailure(new ConfigError(['DATABASE_URL', 'RPC_URL']));
    logStartupFailure(new Error('connect postgresql://user:secret@db failed'));
    written = output.mock.calls.map(([chunk]) => String(chunk));
  } finally {
    output.mockRestore();
  }
  expect(written.join('')).not.toMatch(/postgresql|secret/);
  const records = written.map((line) => JSON.parse(line));
  expect(
    records.map(({ level, message, params }) => ({ level, message, params })),
  ).toEqual([
    {
      level: 'fatal',
      message: 'Startup failed.',
      params: { name: 'ConfigError', variables: ['DATABASE_URL', 'RPC_URL'] },
    },
    { level: 'fatal', message: 'Startup failed.', params: { name: 'Error' } },
  ]);
});
