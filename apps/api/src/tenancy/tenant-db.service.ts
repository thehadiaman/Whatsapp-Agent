import { schema, withTenant, type DbHandle, type Transaction } from '@app/db';
import { Inject, Injectable } from '@nestjs/common';
import type { MemberPrincipal } from '../auth/principal.js';
import { currentRequest } from '../common/request-context.js';
import { DB } from '../infra/tokens.js';

export interface AuditEntryInput {
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
}

/**
 * The only way request handlers touch tenant data: every query runs inside a
 * transaction scoped to the caller's tenant, so row-level security applies
 * even if a query forgets a WHERE clause.
 */
@Injectable()
export class TenantDb {
  constructor(@Inject(DB) private readonly handle: DbHandle) {}

  run<T>(member: MemberPrincipal, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, member.tenantId, fn);
  }

  /** Appends to the audit log in the caller's transaction, so the change and its record commit together. */
  async audit(tx: Transaction, member: MemberPrincipal, entry: AuditEntryInput): Promise<void> {
    await tx.insert(schema.auditLog).values({
      tenantId: member.tenantId,
      actorUserId: member.userId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      before: entry.before ?? null,
      after: entry.after ?? null,
      requestId: currentRequest()?.requestId ?? null,
    });
  }
}
