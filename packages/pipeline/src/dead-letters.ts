import { schema, type Database } from '@app/db';

/** Records a job that retrying will not fix, for the platform admin's view. */
export async function recordDeadLetter(
  db: Database,
  entry: {
    tenantId: string | null;
    queue: string;
    reference: string;
    reason: string;
    attempts: number;
  },
): Promise<void> {
  await db.insert(schema.deadLetters).values(entry);
}
