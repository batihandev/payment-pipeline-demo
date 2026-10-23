import { Controller, Get, Query } from '@nestjs/common';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { IncidentsService } from './incidents.service';

@Controller('incidents')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get()
  list(@Query() query: ListQueryDto): Promise<unknown> {
    return this.incidents.list(query.limit);
  }
}
