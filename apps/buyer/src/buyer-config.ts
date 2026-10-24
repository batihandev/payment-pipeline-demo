import type { z } from 'zod';
import type { buyerSchema } from '@app/config';

export type BuyerConfig = z.output<typeof buyerSchema>;
