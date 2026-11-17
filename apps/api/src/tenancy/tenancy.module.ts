import { Module } from '@nestjs/common';
import {
  AuditLogController,
  MeController,
  PlatformTenantsController,
  TeamController,
  TenantController,
} from './tenancy.controllers.js';
import { TenantDb } from './tenant-db.service.js';

@Module({
  controllers: [
    MeController,
    TenantController,
    TeamController,
    AuditLogController,
    PlatformTenantsController,
  ],
  providers: [TenantDb],
  exports: [TenantDb],
})
export class TenancyModule {}
