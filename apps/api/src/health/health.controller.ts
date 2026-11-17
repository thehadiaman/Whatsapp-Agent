import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Access } from '../auth/access.guard.js';
import { ReadinessService, type ReadinessReport } from './readiness.service.js';

@Controller()
@Access('public')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /** Liveness: the process is up. Checks no dependencies, so a database outage does not cause restarts. */
  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: the API can serve traffic. 503 with per-dependency results otherwise. */
  @Get('ready')
  async ready(): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    if (report.status !== 'ready') {
      throw new ServiceUnavailableException(report);
    }
    return report;
  }
}
