import { expect } from '@jest/globals';
import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigError } from '@app/config';
import { appLogger, errorFields, logStartupFailure } from './index';

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
  const records = written.map((line): unknown => JSON.parse(line));
  expect(records).toEqual([
    expect.objectContaining({
      level: 'fatal',
      message: 'Startup failed.',
      params: { name: 'ConfigError', variables: ['DATABASE_URL', 'RPC_URL'] },
    }),
    expect.objectContaining({
      level: 'fatal',
      message: 'Startup failed.',
      params: { name: 'Error' },
    }),
  ]);
});

const CONNECTION_STRING = 'postgresql://user:secret@db.internal:5432/payments';

async function captured(run: () => Promise<void>): Promise<string> {
  const stdout = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true);
  const stderr = jest
    .spyOn(process.stderr, 'write')
    .mockImplementation(() => true);
  try {
    await run();
    return [...stdout.mock.calls, ...stderr.mock.calls]
      .map(([chunk]) => String(chunk))
      .join('');
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

it('logs a rejected shutdown hook without its message or stack', async () => {
  @Injectable()
  class ClosingProvider implements OnModuleDestroy {
    onModuleDestroy(): Promise<void> {
      return Promise.reject(
        Object.assign(new Error(`cannot close ${CONNECTION_STRING}`), {
          code: 'ECONNRESET',
        }),
      );
    }
  }
  @Module({ providers: [ClosingProvider] })
  class ClosingModule {}

  const log = await captured(async () => {
    const app = await NestFactory.createApplicationContext(ClosingModule, {
      logger: appLogger(),
    });
    await app.close();
  });
  expect(log).toContain('ECONNRESET');
  expect(log).not.toMatch(/postgresql|secret|cannot close|\n\s+at |\\n\s+at /);
  expect(log).not.toContain('"stack"');
  expect(log).not.toContain('"message":"cannot');
});

it('logs a provider failure at boot without its message', async () => {
  @Module({
    providers: [
      {
        provide: 'BROKEN',
        useFactory: () => {
          throw Object.assign(new Error(`connect ${CONNECTION_STRING}`), {
            code: 'ECONNREFUSED',
          });
        },
      },
    ],
  })
  class BrokenModule {}

  const log = await captured(async () => {
    await NestFactory.createApplicationContext(BrokenModule, {
      logger: appLogger(),
      abortOnError: false,
    }).catch(logStartupFailure);
  });
  expect(log).toContain('ECONNREFUSED');
  expect(log).not.toMatch(/postgresql|secret|connect |\\n\s+at |"stack"/);
});
