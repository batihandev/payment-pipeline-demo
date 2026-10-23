import { get, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';

/** Opens `/events` on a listening app and resolves with the response once its headers arrive. */
export async function openEventStream(
  app: INestApplication,
  headers: Record<string, string> = {},
): Promise<IncomingMessage> {
  const server = app.getHttpServer();
  if (!server.listening) await app.listen(0, '127.0.0.1');
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port, path: '/events', headers }, resolve).on(
      'error',
      reject,
    );
  });
}
