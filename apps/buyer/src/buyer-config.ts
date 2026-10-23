import type { z } from 'zod';
import type { buyerSchema } from '../../../libs/config/src';

export type BuyerConfig = z.output<typeof buyerSchema>;
