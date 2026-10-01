import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/** Validates a request body/query with a shared Zod schema; 400 with a Vietnamese message. */
export function parseOrBadRequest<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? ` (${issue.path.join('.')})` : '';
    throw new BadRequestException(`Dữ liệu không hợp lệ${where}: ${issue?.message ?? ''}`.trim());
  }
  return result.data;
}
