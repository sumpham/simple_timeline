import { describe, expect, it } from 'vitest';
import { bookingKindFor, PROVISIONAL_ID, provisionalBooking, quickSpan } from '../client/dragMath.ts';
import type { Environment, Project } from '../shared/types.ts';
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

describe('provisionalBooking', () => {
  const project = { id: 3, team_id: 1, name: 'Huawei Migration', priority: 'normal' } as unknown as Project;
  const env = (kind: Environment['kind']) => ({ id: 7, team_id: 1, name: kind, kind, capacity: 1 }) as unknown as Environment;

  it('draws the planned span with honest day counts', () => {
    const b = provisionalBooking(
      { project, env: env('UAT'), kind: 'UAT', span: { start: '2026-09-30', end: '2026-10-02' } }, none,
    );
    expect(b).toMatchObject({
      id: PROVISIONAL_ID, project_id: 3, environment_id: 7, start_date: '2026-09-30', end_date: '2026-10-02',
      working_days: 3, calendar_days: 3, is_milestone: false, confidence: 'committed',
    });
  });

  it('is a one-day milestone for a release, as the server will save it', () => {
    const b = provisionalBooking(
      { project, env: env('PROD'), kind: 'RELEASE', span: { start: '2026-09-30', end: '2026-10-02' } }, none,
    );
    expect(b).toMatchObject({ start_date: '2026-09-30', end_date: '2026-09-30', is_milestone: true });
  });
});
