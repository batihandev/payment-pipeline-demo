import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../../libs/db/src';
import { publicPayment } from '../../../../libs/events/src/public-payment';
import { receiptNoteKinds } from '../../../../libs/core/src/receipt-notes';
import type { ApiConfig } from '../common/api-config';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  async list(limit: number): Promise<unknown> {
    const donationMin = this.config.get('DONATION_MIN', { infer: true });
    const explorer = this.config.get('BLOCK_EXPLORER_URL', { infer: true });
    const ids = await this.db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM payments WHERE NOT (donation AND amount < ${donationMin}) ORDER BY COALESCE(sent_at, received_at) DESC NULLS LAST, id DESC LIMIT ${limit}`;
    const rows = await this.db.payment.findMany({
      where: { id: { in: ids.map((row) => row.id) } },
      include: {
        incidents: {
          where: { kind: { in: [...receiptNoteKinds] } },
          select: { kind: true },
          distinct: ['kind'],
        },
        order: {
          select: {
            id: true,
            item: true,
            price: true,
            expectedAmount: true,
            status: true,
            source: true,
            createdAt: true,
            expiresAt: true,
          },
        },
      },
    });
    return rows
      .sort(
        (a, b) =>
          ids.findIndex((row) => row.id === a.id) -
          ids.findIndex((row) => row.id === b.id),
      )
      .map(({ incidents, ...row }) => ({
        ...publicPayment(row),
        noteKinds: incidents.map((incident) => incident.kind),
        order: row.order,
        explorerUrl: row.transactionHash
          ? `${explorer.replace(/\/$/, '')}/tx/${row.transactionHash}`
          : null,
      }));
  }
}
