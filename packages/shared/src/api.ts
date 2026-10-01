import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** GET /api/me returns the caller's profile (also for pending/locked accounts). */
export { userProfileSchema as meResponseSchema } from './users.js';
export type { UserProfile as MeResponse } from './users.js';

/** Error body returned by the API for 4xx/5xx responses. Messages are in Vietnamese. */
export const apiErrorSchema = z.object({
  statusCode: z.number(),
  message: z.string(),
});
