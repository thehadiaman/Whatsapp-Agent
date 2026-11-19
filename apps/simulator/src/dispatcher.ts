import { signPayload, SIGNATURE_HEADER } from '@app/whatsapp';
import type { FaultSettings } from './faults.js';

export interface DispatcherOptions {
  webhookUrl: string;
  appSecret: string;
  random: () => number;
  faults: () => FaultSettings;
  onError?: (error: unknown) => void;
}

/**
 * Delivers signed webhooks to the product, the way Meta does: POST, retry on
 * anything but 2xx, with the configured faults applied (delay, duplicates,
 * reordering). Tracks in-flight deliveries so tests can wait for quiet.
 */
export class WebhookDispatcher {
  private inFlight = 0;
  private waiters: (() => void)[] = [];
  delivered = 0;
  failedDeliveries = 0;

  constructor(private readonly options: DispatcherOptions) {}

  send(payload: unknown): void {
    const body = JSON.stringify(payload);
    const faults = this.options.faults();
    const delay = () => faults.delayMs + Math.floor(this.options.random() * faults.reorderWindowMs);
    this.schedule(body, delay());
    if (this.options.random() < faults.duplicateRate) {
      this.schedule(body, delay() + 5);
    }
  }

  private schedule(body: string, delayMs: number): void {
    this.inFlight += 1;
    const timer = setTimeout(() => {
      void this.deliver(body, 1).finally(() => {
        this.inFlight -= 1;
        if (this.inFlight === 0) for (const resolve of this.waiters.splice(0)) resolve();
      });
    }, delayMs);
    timer.unref();
  }

  private async deliver(body: string, attempt: number): Promise<void> {
    try {
      const response = await fetch(this.options.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: signPayload(body, this.options.appSecret),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        this.delivered += 1;
        return;
      }
      throw new Error(`webhook answered ${String(response.status)}`);
    } catch (error) {
      if (attempt >= 6) {
        this.failedDeliveries += 1;
        this.options.onError?.(error);
        return;
      }
      // Meta retries with decreasing frequency; a short version of that.
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** (attempt - 1)));
      await this.deliver(body, attempt + 1);
    }
  }

  /** Resolves when no webhook is waiting or being delivered. */
  idle(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
