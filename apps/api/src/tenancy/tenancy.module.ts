import { Module } from '@nestjs/common';
import {
  AuditLogController,
  DeadLettersController,
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
    DeadLettersController,
  ],
  providers: [TenantDb],
  exports: [TenantDb],
})
export class TenancyModule {}
