import { describe, expect, it } from 'vitest';
import {
  addDays, addWorkingDays, calendarDays, diffDays, isValidISODate, isWeekend,
  overlapDays, snapToWorkingDay, startOfQuarter, startOfWeek, workingDays,
} from '../shared/dates.ts';

describe('calendar arithmetic', () => {
  it('adds days across a month boundary', () => {
    expect(addDays('2026-01-30', 3)).toBe('2026-02-02');
  });

  it('handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
  });

  it('counts an inclusive span', () => {
    expect(calendarDays('2026-03-02', '2026-03-02')).toBe(1);
    expect(calendarDays('2026-03-02', '2026-03-06')).toBe(5);
  });

  it('rejects impossible dates', () => {
    expect(isValidISODate('2026-02-30')).toBe(false);
    expect(isValidISODate('2026-13-01')).toBe(false);
    expect(isValidISODate('2026-3-1')).toBe(false);
    expect(isValidISODate('2026-03-01')).toBe(true);
  });

  it('does not drift with the host timezone', () => {
    // The bug this guards: parsing as local time then formatting shifts the date.
    expect(diffDays('2026-03-01', '2026-03-31')).toBe(30);
    expect(addDays('2026-03-01', 0)).toBe('2026-03-01');
  });
});

describe('working days', () => {
  // 2026-03-02 is a Monday.
  it('identifies weekends', () => {
    expect(isWeekend('2026-03-07')).toBe(true);  // Sat
    expect(isWeekend('2026-03-08')).toBe(true);  // Sun
    expect(isWeekend('2026-03-06')).toBe(false); // Fri
  });

  it('counts a full week as five working days', () => {
    expect(workingDays('2026-03-02', '2026-03-08')).toBe(5);
  });

  it('separates effort from occupancy across a weekend', () => {
    // Fri to Mon: 2 working days of effort, but 4 calendar days of occupancy.
    expect(workingDays('2026-03-06', '2026-03-09')).toBe(2);
    expect(calendarDays('2026-03-06', '2026-03-09')).toBe(4);
  });

  it('excludes holidays from effort', () => {
    const holidays = new Set(['2026-03-04']);
    expect(workingDays('2026-03-02', '2026-03-06')).toBe(5);
    expect(workingDays('2026-03-02', '2026-03-06', holidays)).toBe(4);
  });

  it('snaps forward off a weekend', () => {
    expect(snapToWorkingDay('2026-03-07')).toBe('2026-03-09');
    expect(snapToWorkingDay('2026-03-07', new Set(), -1)).toBe('2026-03-06');
  });

  it('snaps over a holiday that abuts a weekend', () => {
    const holidays = new Set(['2026-03-09']);
    expect(snapToWorkingDay('2026-03-07', holidays)).toBe('2026-03-10');
  });

  it('shifts by working days', () => {
    expect(addWorkingDays('2026-03-06', 1)).toBe('2026-03-09'); // Fri +1 -> Mon
    expect(addWorkingDays('2026-03-09', -1)).toBe('2026-03-06');
    expect(addWorkingDays('2026-03-02', 10)).toBe('2026-03-16');
  });
});

describe('overlap', () => {
  it('counts inclusive overlap', () => {
    expect(overlapDays('2026-03-01', '2026-03-10', '2026-03-05', '2026-03-20')).toBe(6);
  });

  it('reports none for touching but separate ranges', () => {
    expect(overlapDays('2026-03-01', '2026-03-03', '2026-03-04', '2026-03-06')).toBe(0);
  });

  it('reports one for a shared single day', () => {
    expect(overlapDays('2026-03-01', '2026-03-03', '2026-03-03', '2026-03-06')).toBe(1);
  });
});

describe('period starts', () => {
  it('starts weeks on Monday', () => {
    expect(startOfWeek('2026-03-08')).toBe('2026-03-02'); // Sunday belongs to the prior week
    expect(startOfWeek('2026-03-09')).toBe('2026-03-09');
  });

  it('finds quarter starts', () => {
    expect(startOfQuarter('2026-02-14')).toBe('2026-01-01');
    expect(startOfQuarter('2026-08-01')).toBe('2026-07-01');
    expect(startOfQuarter('2026-12-31')).toBe('2026-10-01');
  });
});
