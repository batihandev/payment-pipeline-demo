import type { z } from 'zod';
import type { apiSchema } from '@app/config';

export type ApiConfig = z.output<typeof apiSchema>;
