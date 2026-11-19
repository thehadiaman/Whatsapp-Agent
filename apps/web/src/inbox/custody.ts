import type { ConversationListItem, ConversationState, TimelineEntry } from '@app/shared';

/** Queue groups, in display order (DESIGN.md §3). */
export interface QueueGroups {
  waiting: ConversationListItem[];
  mine: ConversationListItem[];
  others: ConversationListItem[];
  assistant: ConversationListItem[];
}

const latest = (a: ConversationListItem, b: ConversationListItem) =>
  (b.lastMessage?.at ?? '').localeCompare(a.lastMessage?.at ?? '');

/**
 * Waiting first and oldest first (whoever has waited longest is next);
 * then what I hold, what colleagues hold, and what the assistant holds,
 * each with the latest message first.
 */
export function groupQueue(items: readonly ConversationListItem[], meId: string): QueueGroups {
  const groups: QueueGroups = { waiting: [], mine: [], others: [], assistant: [] };
  for (const item of items) {
    if (item.state === 'waiting_for_human') groups.waiting.push(item);
    else if (item.state === 'human' && item.holder?.id === meId) groups.mine.push(item);
    else if (item.state === 'human') groups.others.push(item);
    else if (item.state === 'assistant') groups.assistant.push(item);
  }
  groups.waiting.sort((a, b) => (a.waitingSince ?? '').localeCompare(b.waitingSince ?? ''));
  groups.mine.sort(latest);
  groups.others.sort(latest);
  groups.assistant.sort(latest);
  return groups;
}

/** The queue in the order it is shown, for j/k navigation. */
export function queueOrder(groups: QueueGroups): ConversationListItem[] {
  return [...groups.waiting, ...groups.mine, ...groups.others, ...groups.assistant];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** Who holds it, as the stamp reads. Uppercase is applied by the .stamp class. */
export function holderLabel(state: ConversationState, holderName: string | null): string {
  switch (state) {
    case 'assistant':
      return 'Assistant';
    case 'waiting_for_human':
      return 'Waiting';
    case 'human':
      return holderName ?? 'A person';
    case 'closed':
      return 'Closed';
  }
}

/**
 * The holder at each point of a thread, so every line can carry the custody
 * margin of its moment: the margin shows the conversation's history at a glance.
 */
export function custodyAlongTimeline(timeline: readonly TimelineEntry[]): ConversationState[] {
  let state: ConversationState = 'assistant';
  return timeline.map((entry) => {
    if (entry.type === 'transition') state = entry.to;
    return state;
  });
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ${String(minutes % 60)}m`;
  return `${String(Math.floor(hours / 24))}d`;
}

const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

/** 14:20 today; 15 Nov 14:20 otherwise. */
export function formatTime(iso: string, now: Date): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay ? timeFormat.format(date) : `${dayFormat.format(date)} ${timeFormat.format(date)}`;
}

export function windowText(closesAt: string | null, now: Date): { open: boolean; text: string } {
  if (!closesAt) return { open: false, text: 'No reply window: the customer has not written yet' };
  const left = new Date(closesAt).getTime() - now.getTime();
  if (left > 0) return { open: true, text: `Reply window open · ${formatDuration(left)} left` };
  return { open: false, text: `Reply window closed ${formatDuration(-left)} ago` };
}

/** +971 50 000 0101 style, for display only. */
export function formatPhone(waId: string | null): string | null {
  if (!waId) return null;
  if (waId.startsWith('971') && waId.length === 12) {
    return `+971 ${waId.slice(3, 5)} ${waId.slice(5, 8)} ${waId.slice(8)}`;
  }
  if (waId.startsWith('91') && waId.length === 12) {
    return `+91 ${waId.slice(2, 7)} ${waId.slice(7)}`;
  }
  return `+${waId}`;
}

export function displayName(customer: { name: string | null; phone: string | null }): string {
  return customer.name ?? formatPhone(customer.phone) ?? 'Customer';
}

export function tokenNumber(n: number): string {
  return String(n).padStart(3, '0');
}
