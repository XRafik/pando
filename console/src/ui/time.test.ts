import { describe, expect, it } from 'vitest';

import { day, stamp } from './time';

describe('stamp', () => {
  const now = new Date(2026, 9, 24, 15, 0);

  it('is the date and the time of day, with no year this year', () => {
    expect(stamp(new Date(2026, 9, 24, 14, 32).toISOString(), now)).toBe('Oct 24 14:32');
    expect(stamp(new Date(2026, 0, 2, 9, 5).toISOString(), now)).toBe('Jan 2 09:05');
  });

  it('carries the year when it is not this one', () => {
    expect(stamp(new Date(2025, 11, 31, 23, 59).toISOString(), now)).toBe('Dec 31, 2025 23:59');
    expect(day(new Date(2027, 0, 22).toISOString(), now)).toBe('Jan 22, 2027');
  });

  it('leaves what is not a time as it is', () => {
    expect(stamp('soon', now)).toBe('soon');
    expect(day('soon', now)).toBe('soon');
  });
});
