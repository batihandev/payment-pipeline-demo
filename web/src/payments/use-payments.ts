import { useSyncExternalStore } from 'react';
import { PaymentsClient } from './client';

const clients = new Map<string, PaymentsClient>();
export function paymentsClient(apiBaseUrl: string): PaymentsClient {
  const url = apiBaseUrl.replace(/\/$/, '');
  let client = clients.get(url);
  if (!client) {
    client = new PaymentsClient(url);
    clients.set(url, client);
  }
  return client;
}
export function usePayments(apiBaseUrl: string) {
  const client = paymentsClient(apiBaseUrl);
  return useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot,
  );
}
