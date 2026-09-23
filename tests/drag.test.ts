import { describe, expect, it } from 'vitest';
import { applyDrag, moveBooking, resizeEnd, resizeStart, withSpan } from '../client/dragMath.ts';
import { workingDays } from '../shared/dates.ts';
import type { BookingView } from '../shared/types.ts';

const NONE = new Set<string>();

// 2026-03-02 is a Monday; 03-07/03-08 are the weekend.
const booking = (p: Partial<BookingView> & { start_date: string; end_date: string }): BookingView => ({
  id: 1, project_id: 1, environment_id: 1, kind: 'SIT', confidence: 'committed', optional: 0, note: null, marker: null,
  project_name: 'P', team_id: 1, priority: 'normal', env_name: 'SIT', env_kind: 'SIT',
  capacity: 1, calendar_days: 1, working_days: 1, is_milestone: false, ...p,
});

describe('moveBooking', () => {
  it('moves by whole days', () => {
    const b = booking({ start_date: '2026-03-02', end_date: '2026-03-06' });
    expect(moveBooking(b, 7, NONE)).toEqual({ start: '2026-03-09', end: '2026-03-13' });
  });

  it('keeps the working-day length when crossing a weekend', () => {
    // A 5-working-day booking dragged 3 days lands Thu-Wed: still 5 working days,
    // though it now spans 7 calendar days.
    const b = booking({ start_date: '2026-03-02', end_date: '2026-03-06' });
    const moved = moveBooking(b, 3, NONE);
    expect(moved).toEqual({ start: '2026-03-05', end: '2026-03-11' });
    expect(workingDays(moved.start, moved.end)).toBe(5);
  });

  it('never lands a start on a weekend', () => {
    const b = booking({ start_date: '2026-03-02', end_date: '2026-03-06' });
    for (let d = -10; d <= 10; d++) {
      const moved = moveBooking(b, d, NONE);
      expect(workingDays(moved.start, moved.start)).toBe(1);
      expect(workingDays(moved.end, moved.end)).toBe(1);
    }
  });

  it('steps over a holiday', () => {
    const holidays = new Set(['2026-03-09']);
    const b = booking({ start_date: '2026-03-02', end_date: '2026-03-06' });
    expect(moveBooking(b, 7, holidays).start).toBe('2026-03-10');
  });

  it('keeps a milestone a single day', () => {
    const b = booking({ kind: 'RELEASE', is_milestone: true, start_date: '2026-03-04', end_date: '2026-03-04' });
    const moved = moveBooking(b, 1, NONE);
    expect(moved.start).toBe(moved.end);
    expect(moved.start).toBe('2026-03-05');
  });

  it('snaps a milestone off a weekend in the direction of travel', () => {
    const b = booking({ kind: 'RELEASE', is_milestone: true, start_date: '2026-03-06', end_date: '2026-03-06' });
    expect(moveBooking(b, 1, NONE).start).toBe('2026-03-09');  // forward past Sat/Sun
    const back = booking({ kind: 'RELEASE', is_milestone: true, start_date: '2026-03-09', end_date: '2026-03-09' });
    expect(moveBooking(back, -1, NONE).start).toBe('2026-03-06');
  });
});

describe('resize', () => {
  it('drags the right edge, leaving the left alone', () => {
    const b = booking({ start_date: '2026-03-02', end_date: '2026-03-06' });
    expect(resizeEnd(b, 5, NONE)).toEqual({ start: '2026-03-02', end: '2026-03-11' });
  });

  it('drags the left edge, leaving the right alone', () => {
    const b = booking({ start_date: '2026-03-09', end_date: '2026-03-13' });
    expect(resizeStart(b, -5, NONE)).toEqual({ start: '2026-03-04', end: '2026-03-13' });
  });

  it('refuses to invert when the right edge is dragged past the left', () => {
    const b = booking({ start_date: '2026-03-09', end_date: '2026-03-13' });
    const r = resizeEnd(b, -20, NONE);
    expect(r.start).toBe('2026-03-09');
    expect(r.end).toBe('2026-03-09');
  });

  it('refuses to invert when the left edge is dragged past the right', () => {
    const b = booking({ start_date: '2026-03-09', end_date: '2026-03-13' });
    const r = resizeStart(b, 20, NONE);
    expect(r.start).toBe('2026-03-13');
    expect(r.end).toBe('2026-03-13');
  });

  it('lands both edges on working days at any delta', () => {
    const b = booking({ start_date: '2026-03-09', end_date: '2026-03-13' });
    for (let d = -12; d <= 12; d++) {
      for (const span of [resizeStart(b, d, NONE), resizeEnd(b, d, NONE)]) {
        expect(workingDays(span.start, span.start)).toBe(1);
        expect(workingDays(span.end, span.end)).toBe(1);
        expect(span.end >= span.start).toBe(true);
      }
    }
  });
});

describe('applyDrag and withSpan', () => {
  it('routes each mode to its own behaviour', () => {
    const b = booking({ start_date: '2026-03-02', end_date: '2026-03-06' });
    expect(applyDrag(b, 'move', 7, NONE).start).toBe('2026-03-09');
    expect(applyDrag(b, 'resize-end', 7, NONE).start).toBe('2026-03-02');
    expect(applyDrag(b, 'resize-start', -7, NONE).end).toBe('2026-03-06');
  });

  it('is a no-op at zero delta', () => {
    const b = booking({ start_date: '2026-03-02', end_date: '2026-03-06' });
    expect(applyDrag(b, 'move', 0, NONE)).toEqual({ start: '2026-03-02', end: '2026-03-06' });
  });

  it('recomputes the day counts so labels and conflicts stay truthful', () => {
    const b = booking({ start_date: '2026-03-02', end_date: '2026-03-06', calendar_days: 5, working_days: 5 });
    const moved = withSpan(b, { start: '2026-03-05', end: '2026-03-11' }, NONE);
    expect(moved.calendar_days).toBe(7);
    expect(moved.working_days).toBe(5);
  });
});
