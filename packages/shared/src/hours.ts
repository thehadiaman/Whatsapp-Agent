import { z } from 'zod';

/**
 * Weekly opening hours in the business's own time zone. One span a day, or
 * closed. No overnight spans in v1: a shop that closes after midnight sets
 * 23:59 (recorded in DECISIONS.md).
 */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_NAMES: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM, 24-hour');
const daySchema = z
  .object({ open: hhmm, close: hhmm })
  .refine((d) => d.open < d.close, { message: 'closing time must be after opening time' })
  .nullable();

export const openingHoursSchema = z.object({
  mon: daySchema,
  tue: daySchema,
  wed: daySchema,
  thu: daySchema,
  fri: daySchema,
  sat: daySchema,
  sun: daySchema,
});
export type OpeningHours = z.infer<typeof openingHoursSchema>;

const minutesOf = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));

/** The weekday, date and minute of the day at `at` in `timezone`. */
export function localTime(
  at: Date,
  timezone: string,
): { weekday: Weekday; minutes: number; year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    weekday: get('weekday').toLowerCase().slice(0, 3) as Weekday,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
  };
}

/** Whether the business is open at `at`. Hours not set: treated as always open. */
export function isOpen(hours: OpeningHours | null, timezone: string, at: Date): boolean {
  if (!hours) return true;
  const now = localTime(at, timezone);
  const today = hours[now.weekday];
  return (
    today !== null && now.minutes >= minutesOf(today.open) && now.minutes < minutesOf(today.close)
  );
}

/** The UTC instant of a wall-clock time in a time zone (two passes cover DST changes). */
function zonedInstant(
  date: { year: number; month: number; day: number },
  minutes: number,
  timezone: string,
): Date {
  const wall = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    Math.floor(minutes / 60),
    minutes % 60,
  );
  let guess = wall;
  for (let i = 0; i < 2; i += 1) {
    const seen = localTime(new Date(guess), timezone);
    const seenWall = Date.UTC(
      seen.year,
      seen.month - 1,
      seen.day,
      Math.floor(seen.minutes / 60),
      seen.minutes % 60,
    );
    guess += wall - seenWall;
  }
  return new Date(guess);
}

/**
 * When the business next opens after `at`, or null when it is open now, its
 * hours are not set, or it is never open.
 */
export function nextOpening(hours: OpeningHours | null, timezone: string, at: Date): Date | null {
  if (!hours || isOpen(hours, timezone, at)) return null;
  const now = localTime(at, timezone);
  const start = WEEKDAYS.indexOf(now.weekday);
  for (let ahead = 0; ahead <= 7; ahead += 1) {
    const weekday = WEEKDAYS[(start + ahead) % 7] as Weekday;
    const span = hours[weekday];
    if (!span) continue;
    const open = minutesOf(span.open);
    if (ahead === 0 && open <= now.minutes) continue;
    // Calendar arithmetic on the local date, then back to an instant.
    const local = new Date(Date.UTC(now.year, now.month - 1, now.day + ahead));
    return zonedInstant(
      { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() },
      open,
      timezone,
    );
  }
  return null;
}

/** "Mon–Thu 10:00–22:00 · Fri 14:00–22:00 · Sun closed": consecutive equal days grouped. */
export function describeHours(hours: OpeningHours): string {
  const label = (d: Weekday) => WEEKDAY_NAMES[d].slice(0, 3);
  const span = (d: Weekday) => {
    const h = hours[d];
    return h ? `${h.open}–${h.close}` : 'closed';
  };
  const groups: { from: Weekday; to: Weekday; text: string }[] = [];
  for (const day of WEEKDAYS) {
    const last = groups.at(-1);
    if (last && last.text === span(day)) last.to = day;
    else groups.push({ from: day, to: day, text: span(day) });
  }
  return groups
    .map((g) => `${g.from === g.to ? label(g.from) : `${label(g.from)}–${label(g.to)}`} ${g.text}`)
    .join(' · ');
}
