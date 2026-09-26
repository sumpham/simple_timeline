import { describe, expect, it } from 'vitest';
import { bookingKindFor, quickSpan } from '../client/dragMath.ts';
import { isWorkingDay } from '../shared/dates.ts';

const none = new Set<string>();

describe('quickSpan', () => {
  it('books from the clicked day to that Friday', () => {
    expect(quickSpan('2026-09-28', none)).toEqual({ start: '2026-09-28', end: '2026-10-02' }); // Mon
    expect(quickSpan('2026-09-30', none)).toEqual({ start: '2026-09-30', end: '2026-10-02' }); // Wed
  });

  it('is a single day when clicked on a Friday', () => {
    expect(quickSpan('2026-10-02', none)).toEqual({ start: '2026-10-02', end: '2026-10-02' });
  });

  it('starts the following week when clicked on a weekend', () => {
    expect(quickSpan('2026-09-26', none)).toEqual({ start: '2026-09-28', end: '2026-10-02' }); // Sat
    expect(quickSpan('2026-09-27', none)).toEqual({ start: '2026-09-28', end: '2026-10-02' }); // Sun
  });

  it('stops short of a Friday holiday', () => {
    expect(quickSpan('2026-09-28', new Set(['2026-10-02']))).toEqual({ start: '2026-09-28', end: '2026-10-01' });
  });

  it('skips a clicked holiday and never inverts', () => {
    const holidays = new Set(['2026-10-01', '2026-10-02']);
    expect(quickSpan('2026-10-01', holidays)).toEqual({ start: '2026-10-05', end: '2026-10-09' });
    expect(quickSpan('2026-09-30', holidays)).toEqual({ start: '2026-09-30', end: '2026-09-30' });
  });

  it('lands on working days for every day of a year', () => {
    const holidays = new Set(['2026-12-25', '2026-12-28', '2026-01-01']);
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 86_400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      const { start, end } = quickSpan(day, holidays);
      expect(isWorkingDay(start, holidays) && isWorkingDay(end, holidays)).toBe(true);
      expect(start <= end && start >= day).toBe(true);
    }
  });
});

describe('bookingKindFor', () => {
  it('maps environments to kinds the server accepts', () => {
    expect(bookingKindFor('UAT')).toBe('UAT');
    expect(bookingKindFor('PROD')).toBe('RELEASE');
    expect(bookingKindFor('OTHER')).toBe('CUSTOM');
  });
});
