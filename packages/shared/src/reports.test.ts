import { describe, expect, it } from 'vitest';
import { periodLabel, previousPeriod } from './reports.js';

describe('report periods', () => {
  it('steps back one month across years and labels it', () => {
    expect(previousPeriod('202610')).toBe('202609');
    expect(previousPeriod('202701')).toBe('202612');
    expect(periodLabel('202609')).toBe('09/2026');
  });
});
