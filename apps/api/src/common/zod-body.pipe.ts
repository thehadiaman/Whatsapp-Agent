import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** Validates a request body against a zod schema; 400 lists every problem. */
export class ZodBody<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: 'The request body is invalid. Fix the fields listed in issues and send it again.',
      issues: result.error.issues.map(
        (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(body)'}: ${issue.message}`,
      ),
    });
  }
}
