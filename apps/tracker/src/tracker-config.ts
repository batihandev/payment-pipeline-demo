import type { z } from 'zod';
import type { trackerSchema } from '../../../libs/config/src';

export type TrackerConfig = z.output<typeof trackerSchema>;
