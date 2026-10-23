import type { IncidentKind } from '../../core/src/incidents';
import type { Prisma } from '../generated/client';

export type IncidentRecord = Omit<
  Prisma.IncidentUncheckedCreateInput,
  'kind'
> & { kind: IncidentKind };

/** Writes one incident. Every writer goes through here, so `kind` is always a known kind. */
export async function recordIncident(
  db: Prisma.TransactionClient,
  data: IncidentRecord,
): Promise<void> {
  await db.incident.create({ data });
}
