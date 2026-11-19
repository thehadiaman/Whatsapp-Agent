import type { ConversationListItem, TimelineEntry } from '@app/shared';
import { describe, expect, it } from 'vitest';
import {
  custodyAlongTimeline,
  formatDuration,
  formatPhone,
  groupQueue,
  initials,
  queueOrder,
  windowText,
} from './custody';

const ME = '00000000-0000-4000-8000-000000000001';
const COLLEAGUE = '00000000-0000-4000-8000-000000000002';

function item(over: Partial<ConversationListItem> & { id: string }): ConversationListItem {
  return {
    number: 1,
    state: 'assistant',
    holder: null,
    customer: { name: 'X', phone: null },
    lastMessage: null,
    waitingSince: null,
    windowClosesAt: null,
    ...over,
  };
}

describe('groupQueue', () => {
  it('puts the longest-waiting customer first, then mine, colleagues’, the assistant’s', () => {
    const groups = groupQueue(
      [
        item({
          id: 'a1',
          state: 'assistant',
          lastMessage: { direction: 'inbound', preview: '', at: '2026-11-19T10:00:00Z' },
        }),
        item({ id: 'w-new', state: 'waiting_for_human', waitingSince: '2026-11-19T10:05:00Z' }),
        item({ id: 'mine', state: 'human', holder: { id: ME, name: 'Me' } }),
        item({ id: 'w-old', state: 'waiting_for_human', waitingSince: '2026-11-19T09:00:00Z' }),
        item({ id: 'theirs', state: 'human', holder: { id: COLLEAGUE, name: 'Priya' } }),
        item({ id: 'closed', state: 'closed' }),
      ],
      ME,
    );
    expect(queueOrder(groups).map((i) => i.id)).toEqual(['w-old', 'w-new', 'mine', 'theirs', 'a1']);
  });
});

describe('custodyAlongTimeline', () => {
  it('gives each line the holder at that moment', () => {
    const t = (to: 'waiting_for_human' | 'human'): TimelineEntry => ({
      type: 'transition',
      id: crypto.randomUUID(),
      at: '2026-11-19T10:00:00Z',
      from: null,
      to,
      actorType: 'system',
      actorName: null,
      reason: '',
    });
    const note: TimelineEntry = {
      type: 'note',
      id: crypto.randomUUID(),
      at: '2026-11-19T10:00:00Z',
      authorName: null,
      body: '',
    };
    expect(custodyAlongTimeline([note, t('waiting_for_human'), note, t('human'), note])).toEqual([
      'assistant',
      'waiting_for_human',
      'waiting_for_human',
      'human',
      'human',
    ]);
  });
});

describe('formatting', () => {
  it('formats durations compactly', () => {
    expect(formatDuration(4 * 60_000)).toBe('4m');
    expect(formatDuration(80 * 60_000)).toBe('1h 20m');
    expect(formatDuration(50 * 3_600_000)).toBe('2d');
  });

  it('states the reply window in plain words', () => {
    const now = new Date('2026-11-19T10:00:00Z');
    expect(windowText('2026-11-20T07:40:00Z', now)).toEqual({
      open: true,
      text: 'Reply window open · 21h 40m left',
    });
    expect(windowText('2026-11-18T08:00:00Z', now)).toEqual({
      open: false,
      text: 'Reply window closed 1d ago',
    });
  });

  it('formats Gulf and Indian numbers and initials', () => {
    expect(formatPhone('971500000101')).toBe('+971 50 000 0101');
    expect(formatPhone('919800000105')).toBe('+91 98000 00105');
    expect(initials('Priya Raman')).toBe('PR');
    expect(initials('Aisha')).toBe('A');
  });
});
