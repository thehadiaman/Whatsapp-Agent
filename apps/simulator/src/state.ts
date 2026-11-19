import { randomBytes } from 'node:crypto';
import { DEMO_BUSINESSES, DEMO_CUSTOMERS } from '@app/shared';

export interface Business {
  phoneNumberId: string;
  displayPhoneNumber: string;
  name: string;
}

export interface Customer {
  id: string;
  name: string;
  bsuid: string;
  waId: string | null;
  businessPhoneNumberId: string;
}

export type ThreadStatus = 'accepted' | 'sent' | 'delivered' | 'read' | 'failed';

export interface ThreadMessage {
  wamid: string;
  /** `in` = customer to business (what our webhook receives), `out` = business to customer. */
  direction: 'in' | 'out';
  type: string;
  text: string | null;
  mediaId: string | null;
  status: ThreadStatus | null;
  at: number;
}

export interface StoredMedia {
  id: string;
  bytes: Uint8Array;
  mimeType: string;
  sha256: string;
}

export function wamid(): string {
  // Real wamids are opaque base64; the prefix keeps simulator IDs recognisable.
  return `wamid.SIM${randomBytes(18).toString('base64url')}`;
}

/** In-memory world of the simulator: numbers, customers, threads, media. */
export class SimulatorState {
  readonly businesses = new Map<string, Business>();
  readonly customers = new Map<string, Customer>();
  readonly threads = new Map<string, ThreadMessage[]>();
  readonly media = new Map<string, StoredMedia>();
  /** Last time each customer wrote to each business: Meta's 24-hour window. */
  readonly lastInbound = new Map<string, number>();
  private mediaSeq = 1;

  constructor(seedDemo = true) {
    if (!seedDemo) return;
    for (const b of DEMO_BUSINESSES) {
      this.businesses.set(b.channel.phoneNumberId, {
        phoneNumberId: b.channel.phoneNumberId,
        displayPhoneNumber: b.channel.displayPhoneNumber,
        name: b.name,
      });
    }
    for (const c of DEMO_CUSTOMERS) {
      const business = DEMO_BUSINESSES.find((b) => b.slug === c.business);
      if (!business) continue;
      this.addCustomer({
        name: c.name,
        bsuid: c.bsuid,
        waId: c.waId,
        businessPhoneNumberId: business.channel.phoneNumberId,
      });
    }
  }

  addCustomer(input: Omit<Customer, 'id'>): Customer {
    const customer = { ...input, id: input.bsuid };
    this.customers.set(customer.id, customer);
    return customer;
  }

  /** Finds the customer a business is addressing, by BSUID (`recipient`) or phone (`to`). */
  findRecipient(businessPhoneNumberId: string, address: string): Customer | undefined {
    for (const c of this.customers.values()) {
      if (c.businessPhoneNumberId !== businessPhoneNumberId) continue;
      if (c.bsuid === address || (c.waId !== null && c.waId === address)) return c;
    }
    return undefined;
  }

  thread(customerId: string): ThreadMessage[] {
    let thread = this.threads.get(customerId);
    if (!thread) {
      thread = [];
      this.threads.set(customerId, thread);
    }
    return thread;
  }

  findMessage(wamidValue: string): { customer: Customer; message: ThreadMessage } | undefined {
    for (const [customerId, thread] of this.threads) {
      const message = thread.find((m) => m.wamid === wamidValue);
      const customer = this.customers.get(customerId);
      if (message && customer) return { customer, message };
    }
    return undefined;
  }

  storeMedia(bytes: Uint8Array, mimeType: string, sha256: string): StoredMedia {
    const id = String(9_000_000_000_000 + this.mediaSeq++);
    const media = { id, bytes, mimeType, sha256 };
    this.media.set(id, media);
    return media;
  }

  reset(): void {
    this.threads.clear();
    this.lastInbound.clear();
  }
}
