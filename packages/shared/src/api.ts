import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const meResponseSchema = z.object({
  uid: z.string(),
  email: z.string(),
  name: z.string().nullable(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** Error body returned by the API for 4xx/5xx responses. Messages are in Vietnamese. */
export const apiErrorSchema = z.object({
  statusCode: z.number(),
  message: z.string(),
});
