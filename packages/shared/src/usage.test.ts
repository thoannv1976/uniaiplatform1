import { describe, expect, it } from 'vitest';
import { forecastPeriod, formatVnd, vnDayOf } from './usage.js';

describe('usage helpers', () => {
  it('uses Vietnam dates', () => {
    expect(vnDayOf(new Date('2026-10-01T17:30:00Z'))).toBe('20261002');
  });

  it('formats VND from micro-USD', () => {
    expect(formatVnd(2_000_000, 26_000)).toBe('52.000 ₫');
  });

  it('projects the month from the last 7 days', () => {
    const now = new Date('2026-10-10T05:00:00Z'); // 10/10 in Vietnam, 21 days left
    const byDay = Array.from({ length: 10 }, (_, i) => ({
      day: `202610${String(i + 1).padStart(2, '0')}`,
      cost: i < 3 ? 0 : 1000,
    }));
    expect(forecastPeriod(7000, byDay, '202610', now)).toBe(7000 + 1000 * 21);
    expect(forecastPeriod(7000, byDay, '202609', now)).toBe(7000);
    // Early in the month only the elapsed days count.
    expect(
      forecastPeriod(
        500,
        [{ day: '20261001', cost: 500 }],
        '202610',
        new Date('2026-10-01T05:00:00Z'),
      ),
    ).toBe(500 + 500 * 30);
  });
});
