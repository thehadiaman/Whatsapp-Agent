import { describe, expect, it } from 'vitest';
import {
  describeHours,
  isOpen,
  nextOpening,
  openingHoursSchema,
  type OpeningHours,
} from './hours.js';

const shop: OpeningHours = {
  mon: { open: '10:00', close: '22:00' },
  tue: { open: '10:00', close: '22:00' },
  wed: { open: '10:00', close: '22:00' },
  thu: { open: '10:00', close: '22:00' },
  fri: { open: '14:00', close: '22:00' },
  sat: { open: '10:00', close: '22:00' },
  sun: null,
};
const DUBAI = 'Asia/Dubai'; // UTC+4, no daylight saving

describe('opening hours', () => {
  it('knows when the shop is open, in its own time zone', () => {
    // Thursday 2026-11-19 09:59 and 10:00 in Dubai.
    expect(isOpen(shop, DUBAI, new Date('2026-11-19T05:59:00Z'))).toBe(false);
    expect(isOpen(shop, DUBAI, new Date('2026-11-19T06:00:00Z'))).toBe(true);
    // Closing time itself is closed.
    expect(isOpen(shop, DUBAI, new Date('2026-11-19T18:00:00Z'))).toBe(false);
    // Hours not set: always open, so nothing is ever "after hours".
    expect(isOpen(null, DUBAI, new Date('2026-11-19T23:00:00Z'))).toBe(true);
  });

  it('finds the next opening: later today, tomorrow, or past a closed day', () => {
    // Thursday 07:00 Dubai → Thursday 10:00.
    expect(nextOpening(shop, DUBAI, new Date('2026-11-19T03:00:00Z'))?.toISOString()).toBe(
      '2026-11-19T06:00:00.000Z',
    );
    // Thursday 23:00 Dubai → Friday 14:00.
    expect(nextOpening(shop, DUBAI, new Date('2026-11-19T19:00:00Z'))?.toISOString()).toBe(
      '2026-11-20T10:00:00.000Z',
    );
    // Saturday 23:00 Dubai → Sunday is closed → Monday 10:00.
    expect(nextOpening(shop, DUBAI, new Date('2026-11-21T19:00:00Z'))?.toISOString()).toBe(
      '2026-11-23T06:00:00.000Z',
    );
    // Open now: no next opening to wait for.
    expect(nextOpening(shop, DUBAI, new Date('2026-11-19T08:00:00Z'))).toBeNull();
  });

  it('follows daylight saving in zones that have it', () => {
    const london = { ...shop, sun: { open: '09:00', close: '17:00' } };
    // Saturday 2026-03-28 23:00 GMT; clocks go forward that night, so Sunday 09:00 is 08:00Z.
    expect(
      nextOpening(london, 'Europe/London', new Date('2026-03-28T23:00:00Z'))?.toISOString(),
    ).toBe('2026-03-29T08:00:00.000Z');
  });

  it('describes the week compactly', () => {
    expect(describeHours(shop)).toBe(
      'Mon–Thu 10:00–22:00 · Fri 14:00–22:00 · Sat 10:00–22:00 · Sun closed',
    );
  });

  it('refuses times that are not HH:MM, and a close before the open', () => {
    expect(
      openingHoursSchema.safeParse({ ...shop, mon: { open: '9:00', close: '22:00' } }).success,
    ).toBe(false);
    expect(
      openingHoursSchema.safeParse({ ...shop, mon: { open: '22:00', close: '10:00' } }).success,
    ).toBe(false);
    expect(openingHoursSchema.safeParse(shop).success).toBe(true);
  });
});
