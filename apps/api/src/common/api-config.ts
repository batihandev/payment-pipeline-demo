import type { z } from 'zod';
import type { apiSchema } from '../../../../libs/config/src';

export type ApiConfig = z.output<typeof apiSchema>;
