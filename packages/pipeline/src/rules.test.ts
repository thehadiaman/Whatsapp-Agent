import { describe, expect, it } from 'vitest';
import {
  canTransition,
  decideSend,
  maySend,
  nextStatus,
  windowState,
  WINDOW_MS,
  type MessageStatus,
} from './rules.js';

describe('nextStatus', () => {
  it('moves forward through sent, delivered, read, played', () => {
    let status: MessageStatus = 'sending';
    for (const incoming of ['sent', 'delivered', 'read', 'played'] as const) {
      status = nextStatus(status, incoming);
      expect(status).toBe(incoming);
    }
  });

  it('never moves backwards when events arrive out of order', () => {
    expect(nextStatus('read', 'delivered')).toBe('read');
    expect(nextStatus('delivered', 'sent')).toBe('delivered');
  });

  it('applies the same final status whatever order events arrive in', () => {
    const events: MessageStatus[] = ['read', 'sent', 'delivered', 'sent', 'read'];
    const forwards = events.reduce<MessageStatus>(nextStatus, 'sending');
    const backwards = [...events].reverse().reduce<MessageStatus>(nextStatus, 'sending');
    expect(forwards).toBe('read');
    expect(backwards).toBe('read');
  });

  it('lets failed override sent but not delivered', () => {
    expect(nextStatus('sent', 'failed')).toBe('failed');
    expect(nextStatus('delivered', 'failed')).toBe('delivered');
  });

  it('never changes a cancelled message', () => {
    expect(nextStatus('cancelled', 'sent')).toBe('cancelled');
  });
});

describe('windowState', () => {
  const at = new Date('2026-11-17T10:00:00Z');

  it('is open for 24 hours after the last customer message', () => {
    expect(windowState(at, new Date(at.getTime() + WINDOW_MS - 1)).open).toBe(true);
    expect(windowState(at, new Date(at.getTime() + WINDOW_MS)).open).toBe(false);
  });

  it('is closed if the customer never wrote', () => {
    expect(windowState(null, at)).toEqual({ open: false, closesAt: null });
  });
});

describe('decideSend', () => {
  const now = new Date('2026-11-17T10:00:00Z');
  const hold = 10_000;
  const msg = { outboxSeq: 3, status: 'queued' as const, sentAt: null };

  it('sends the first message at once', () => {
    expect(decideSend({ ...msg, outboxSeq: 1 }, [], now, hold)).toEqual({ action: 'send' });
  });

  it('waits while an earlier reply is still queued or being sent', () => {
    const decision = decideSend(
      msg,
      [{ outboxSeq: 2, status: 'sending', sentAt: null }],
      now,
      hold,
    );
    expect(decision).toMatchObject({ action: 'wait', reason: 'earlier-unsent' });
  });

  it('waits for the previous reply to be delivered, up to the hold time', () => {
    const sentAt = new Date(now.getTime() - 2_000);
    const decision = decideSend(msg, [{ outboxSeq: 2, status: 'sent', sentAt }], now, hold);
    expect(decision).toEqual({
      action: 'wait',
      until: new Date(sentAt.getTime() + hold),
      reason: 'earlier-undelivered',
    });
  });

  it('stops waiting once the hold time has passed (customer offline)', () => {
    const sentAt = new Date(now.getTime() - hold - 1);
    expect(decideSend(msg, [{ outboxSeq: 2, status: 'sent', sentAt }], now, hold)).toEqual({
      action: 'send',
    });
  });

  it('sends once the previous reply is delivered, read or failed', () => {
    for (const status of ['delivered', 'read', 'failed'] as const) {
      const outbox = [{ outboxSeq: 2, status, sentAt: now }];
      expect(decideSend(msg, outbox, now, hold)).toEqual({ action: 'send' });
    }
  });

  it('ignores later messages', () => {
    const outbox = [{ outboxSeq: 4, status: 'queued' as const, sentAt: null }];
    expect(decideSend(msg, outbox, now, hold)).toEqual({ action: 'send' });
  });
});

describe('conversation ownership', () => {
  it('allows the documented transitions and nothing out of closed', () => {
    expect(canTransition('assistant', 'human')).toBe(true);
    expect(canTransition('waiting_for_human', 'human')).toBe(true);
    expect(canTransition('human', 'assistant')).toBe(true);
    expect(canTransition('closed', 'assistant')).toBe(false);
    expect(canTransition('assistant', 'assistant')).toBe(false);
    expect(canTransition('human', 'human')).toBe(true); // reassignment
  });

  it('never lets the assistant send while a person holds the conversation', () => {
    expect(maySend('assistant', null, { type: 'assistant' })).toBe(true);
    expect(maySend('human', 'u1', { type: 'assistant' })).toBe(false);
    expect(maySend('waiting_for_human', null, { type: 'assistant' })).toBe(false);
  });

  it('lets only the holder reply when a person holds it', () => {
    expect(maySend('human', 'u1', { type: 'user', userId: 'u1' })).toBe(true);
    expect(maySend('human', 'u1', { type: 'user', userId: 'u2' })).toBe(false);
    expect(maySend('assistant', null, { type: 'user', userId: 'u1' })).toBe(false);
  });
});
