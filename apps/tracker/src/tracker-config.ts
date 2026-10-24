import type { z } from 'zod';
import type { trackerSchema } from '@app/config';

export type TrackerConfig = z.output<typeof trackerSchema>;
