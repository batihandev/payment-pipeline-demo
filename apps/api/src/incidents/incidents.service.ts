import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../libs/db/src';
import { json } from '../common/json';

@Injectable()
export class IncidentsService {
  constructor(private readonly db: PrismaService) {}

  async list(limit: number): Promise<unknown> {
    return json(
      await this.db.incident.findMany({
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  }
}
