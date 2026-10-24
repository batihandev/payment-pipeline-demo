import { UnrecoverableError } from 'bullmq';
import { RpcError } from '@app/chain/rpc-error';

/** Turns a failed job's error into what BullMQ should do: stop retrying, or retry. */
export function mapJobError(error: unknown): never {
  if (error instanceof RpcError && error.kind === 'permanent')
    throw new UnrecoverableError(error.message);
  if (error instanceof UnrecoverableError) throw error;
  throw new RpcError('transient');
}
