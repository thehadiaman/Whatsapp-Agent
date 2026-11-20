/**
 * Pure rules of the pipeline, kept free of I/O so they can be unit-tested
 * exhaustively: status ordering, the 24-hour window, send ordering and the
 * conversation state machine.
 */

export type MessageStatus =
  | 'received'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'played'
  | 'failed'
  | 'cancelled';

export type ConversationState = 'assistant' | 'waiting_for_human' | 'human' | 'closed';

// ---------------------------------------------------------------------------
// Status: webhooks arrive late, twice, or out of order. A status only ever
// moves forward. `failed` beats `sent` but never undoes `delivered`.
// ---------------------------------------------------------------------------

const STATUS_RANK: Record<MessageStatus, number> = {
  received: 0,
  cancelled: 0,
  queued: 0,
  sending: 1,
  sent: 2,
  failed: 2.5,
  delivered: 3,
  read: 4,
  played: 5,
};

const WEBHOOK_STATUSES = new Set(['sent', 'delivered', 'read', 'played', 'failed']);

export function isWebhookStatus(value: string): value is MessageStatus {
  return WEBHOOK_STATUSES.has(value);
}

export function nextStatus(current: MessageStatus, incoming: MessageStatus): MessageStatus {
  if (current === 'cancelled' || current === 'received') return current;
  return STATUS_RANK[incoming] > STATUS_RANK[current] ? incoming : current;
}

// ---------------------------------------------------------------------------
// Customer service window: 24 hours from the customer's last message.
// ---------------------------------------------------------------------------

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WindowState {
  open: boolean;
  closesAt: Date | null;
}

export function windowState(lastInboundAt: Date | null, now: Date): WindowState {
  if (!lastInboundAt) return { open: false, closesAt: null };
  const closesAt = new Date(lastInboundAt.getTime() + WINDOW_MS);
  return { open: now < closesAt, closesAt };
}

// ---------------------------------------------------------------------------
// Send ordering within a conversation. Meta does not guarantee delivery in
// request order and advises waiting for `delivered` before the next message
// in a sequence. We wait for it, but only up to `holdMs`, so one customer with
// their phone off cannot block a conversation forever (decision P-02).
// ---------------------------------------------------------------------------

export interface OutboxEntry {
  outboxSeq: number;
  status: MessageStatus;
  sentAt: Date | null;
}

export type SendDecision =
  | { action: 'send' }
  | { action: 'wait'; until: Date; reason: 'earlier-unsent' | 'earlier-undelivered' };

export const UNSENT_POLL_MS = 500;

export function decideSend(
  message: OutboxEntry,
  conversationOutbox: readonly OutboxEntry[],
  now: Date,
  holdMs: number,
): SendDecision {
  const earlier = conversationOutbox.filter((e) => e.outboxSeq < message.outboxSeq);
  if (earlier.some((e) => e.status === 'queued' || e.status === 'sending')) {
    return {
      action: 'wait',
      until: new Date(now.getTime() + UNSENT_POLL_MS),
      reason: 'earlier-unsent',
    };
  }
  const previous = earlier.reduce<OutboxEntry | null>(
    (latest, e) => (latest === null || e.outboxSeq > latest.outboxSeq ? e : latest),
    null,
  );
  if (previous?.status === 'sent' && previous.sentAt) {
    const until = new Date(previous.sentAt.getTime() + holdMs);
    if (until > now) return { action: 'wait', until, reason: 'earlier-undelivered' };
  }
  return { action: 'send' };
}

// ---------------------------------------------------------------------------
// Conversation ownership. Exactly one state at a time; closed is final (a new
// customer message after closing starts a new conversation).
// ---------------------------------------------------------------------------

const ALLOWED: Record<ConversationState, readonly ConversationState[]> = {
  assistant: ['waiting_for_human', 'human', 'closed'],
  waiting_for_human: ['human', 'assistant', 'closed'],
  // human → human: reassigned to another person.
  human: ['assistant', 'waiting_for_human', 'human', 'closed'],
  closed: [],
};

export function canTransition(from: ConversationState, to: ConversationState): boolean {
  return ALLOWED[from].includes(to);
}

/**
 * Whether an assistant message already queued may still go out. A person
 * holding (or having closed) the conversation cancels it: the assistant never
 * sends while a human holds it (brief §4). While the conversation only waits
 * for a person, the assistant's last word, usually "a person will reply here
 * soon", still goes out.
 */
export function assistantMessageMayGo(state: ConversationState): boolean {
  return state === 'assistant' || state === 'waiting_for_human';
}

/** Who may send into a conversation right now. */
export function maySend(
  state: ConversationState,
  holderUserId: string | null,
  sender: { type: 'assistant' } | { type: 'user'; userId: string },
): boolean {
  if (sender.type === 'assistant') return state === 'assistant';
  return state === 'human' && holderUserId === sender.userId;
}
