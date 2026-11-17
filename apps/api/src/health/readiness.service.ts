import type { Logger } from '@app/shared';
import { Inject, Injectable } from '@nestjs/common';
import { LOGGER } from '../infra/tokens.js';

/** A dependency the API needs before it can serve traffic. */
export interface ReadinessProbe {
  readonly name: string;
  check(): Promise<void>;
}

export type ProbeResult = 'ok' | 'failed' | 'timed_out';

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checks: Record<string, ProbeResult>;
}

export const READINESS_PROBES = Symbol('READINESS_PROBES');
export const READINESS_TIMEOUT_MS = Symbol('READINESS_TIMEOUT_MS');

@Injectable()
export class ReadinessService {
  constructor(
    @Inject(READINESS_PROBES) private readonly probes: readonly ReadinessProbe[],
    @Inject(READINESS_TIMEOUT_MS) private readonly timeoutMs: number,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Runs every probe in parallel with a timeout each. The report names each
   * probe's outcome but never includes error details, which can reveal hosts
   * or credentials; those go to the log instead.
   */
  async check(): Promise<ReadinessReport> {
    const entries = await Promise.all(
      this.probes.map(async (probe) => [probe.name, await this.run(probe)] as const),
    );
    const checks = Object.fromEntries(entries);
    const ready = entries.every(([, result]) => result === 'ok');
    return { status: ready ? 'ready' : 'not_ready', checks };
  }

  private async run(probe: ReadinessProbe): Promise<ProbeResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timed_out'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timed_out');
      }, this.timeoutMs);
    });
    try {
      const result = await Promise.race([probe.check().then(() => 'ok' as const), timeout]);
      if (result === 'timed_out') {
        this.logger.warn(
          { probe: probe.name, timeoutMs: this.timeoutMs },
          'readiness probe timed out',
        );
      }
      return result;
    } catch (error) {
      this.logger.warn({ probe: probe.name, err: error }, 'readiness probe failed');
      return 'failed';
    } finally {
      clearTimeout(timer);
    }
  }
}
