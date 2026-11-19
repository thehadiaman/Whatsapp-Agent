import type { Business, Customer } from './state.js';

/**
 * Webhook payloads in Meta's documented shape (Cloud API webhook reference,
 * checked 2026-11-17). Written independently of the product's parser; a test
 * checks these against the same Meta fixtures the parser is tested with.
 */

export type InboundItem =
  | { customer: Customer; wamid: string; at: number; type: 'text'; text: string }
  | {
      customer: Customer;
      wamid: string;
      at: number;
      type: 'image' | 'document' | 'audio';
      media: { id: string; mimeType: string; sha256: string };
      caption?: string;
      filename?: string;
      voice?: boolean;
    };

export interface StatusItem {
  customer: Customer;
  wamid: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  at: number;
}

const seconds = (ms: number) => String(Math.floor(ms / 1000));

function envelope(business: Business, value: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        // WhatsApp Business Account ID; the simulator uses one per number.
        id: `2${business.phoneNumberId.slice(1)}`,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: business.displayPhoneNumber.replace(/\D/g, ''),
                phone_number_id: business.phoneNumberId,
              },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

function contact(customer: Customer) {
  return {
    profile: { name: customer.name },
    ...(customer.waId ? { wa_id: customer.waId } : {}),
    user_id: customer.bsuid,
  };
}

/** One payload may carry several messages, as Meta batches them. */
export function inboundPayload(business: Business, items: InboundItem[]) {
  const customers = [...new Map(items.map((i) => [i.customer.id, i.customer])).values()];
  return envelope(business, {
    contacts: customers.map(contact),
    messages: items.map((item) => {
      const base = {
        ...(item.customer.waId ? { from: item.customer.waId } : {}),
        from_user_id: item.customer.bsuid,
        id: item.wamid,
        timestamp: seconds(item.at),
        type: item.type,
      };
      if (item.type === 'text') return { ...base, text: { body: item.text } };
      return {
        ...base,
        [item.type]: {
          id: item.media.id,
          mime_type: item.media.mimeType,
          sha256: item.media.sha256,
          ...(item.caption ? { caption: item.caption } : {}),
          ...(item.filename ? { filename: item.filename } : {}),
          ...(item.type === 'audio' ? { voice: item.voice ?? false } : {}),
        },
      };
    }),
  });
}

export function statusPayload(business: Business, item: StatusItem) {
  return envelope(business, {
    statuses: [
      {
        id: item.wamid,
        status: item.status,
        timestamp: seconds(item.at),
        ...(item.customer.waId ? { recipient_id: item.customer.waId } : {}),
        recipient_user_id: item.customer.bsuid,
        ...(item.status === 'failed'
          ? {
              errors: [
                {
                  code: 131026,
                  title: 'Message undeliverable',
                  message: 'Message undeliverable',
                  error_data: { details: 'Unable to deliver message.' },
                },
              ],
            }
          : {}),
      },
    ],
  });
}
