import { analyticsPeriodSchema, type Analytics } from '@app/shared';
import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { Access } from '../auth/access.guard.js';
import { CurrentMember, type MemberPrincipal } from '../auth/principal.js';
import { TenantDb } from '../tenancy/tenant-db.service.js';
import { analytics } from './analytics.queries.js';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly tenantDb: TenantDb) {}

  /** `?days=7` (default) or `?days=30`, compared with the same span before it. */
  @Get()
  @Access('member')
  read(
    @CurrentMember() member: MemberPrincipal,
    @Query('days') days: string | undefined,
  ): Promise<Analytics> {
    const parsed = analyticsPeriodSchema.safeParse(days ?? 7);
    if (!parsed.success) throw new BadRequestException('days must be 7 or 30.');
    return this.tenantDb.run(member, (tx) => analytics(tx, parsed.data));
  }
}
