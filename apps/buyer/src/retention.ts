import type { PrismaClient } from '../../../libs/db/src';
export async function pruneOlderThan(
  db: PrismaClient,
  cutoff: Date,
): Promise<Record<string, number>> {
  return db.$transaction(async (tx) => {
    const eligible = await tx.payment.findMany({
      where: {
        // Incidents newer than the cutoff still reference their payment.
        incidents: { none: { createdAt: { gte: cutoff } } },
        // Only final payments go: settled ones by settle time, unmatched ones by receive time.
        final: true,
        OR: [
          { settledAt: { lt: cutoff } },
          { orderId: null, receivedAt: { lt: cutoff } },
        ],
      },
      select: { id: true },
    });
    const paymentId = { in: eligible.map(({ id }) => id) };
    const events = await tx.paymentEvent.deleteMany({ where: { paymentId } });
    const notices = await tx.notice.deleteMany({ where: { paymentId } });
    const ledgerEntries = await tx.ledgerEntry.deleteMany({
      where: { paymentId },
    });
    const incidents = await tx.incident.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    const payments = await tx.payment.deleteMany({ where: { id: paymentId } });
    const orders = await tx.order.deleteMany({
      where: {
        status: { in: ['paid', 'expired'] },
        createdAt: { lt: cutoff },
        payments: { none: {} },
      },
    });
    const scanGaps = await tx.scanGap.deleteMany({
      where: { resolvedAt: { lt: cutoff } },
    });
    const dailyBudgets = await tx.dailyBudget.deleteMany({
      where: { day: { lt: cutoff } },
    });
    const sweeps = await tx.sweep.deleteMany({
      where: { sendState: 'sent', createdAt: { lt: cutoff } },
    });
    return {
      events: events.count,
      notices: notices.count,
      ledgerEntries: ledgerEntries.count,
      incidents: incidents.count,
      payments: payments.count,
      orders: orders.count,
      scanGaps: scanGaps.count,
      dailyBudgets: dailyBudgets.count,
      sweeps: sweeps.count,
    };
  });
}
