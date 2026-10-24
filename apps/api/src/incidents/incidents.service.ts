import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/db';

@Injectable()
export class IncidentsService {
  constructor(private readonly db: PrismaService) {}

  list(limit: number): Promise<unknown> {
    return this.db.incident.findMany({
      take: limit,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }
}
