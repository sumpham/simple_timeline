import { describe, expect, it } from 'vitest';
import { earnedValue, formatMoney, planCost, plannedCost, plannedShare, type EarnedValue, type EarnedValueInput } from '../shared/earnedValue.ts';
import { scheduleProject } from '../shared/schedule.ts';
import type { Task } from '../shared/types.ts';

// 2026-03-02 is a Monday.
const MON = '2026-03-02';
const WED = '2026-03-04';

function task(id: number, duration: number, partial: Partial<Task> = {}): Task {
  return {
    id, project_id: 1, environment_id: null, name: `T${id}`, duration, status: 'todo', not_before: null,
    note: null, sort_order: id, actual_start: null, actual_end: null, code: id,
    start_date: null, end_date: null, total_float: null, critical: 0, ...partial,
  };
}

/** A plan, its baseline taken as it stands (or as given), Mai at 100 a day. */
function input(tasks: Task[], o: Partial<EarnedValueInput> & { people?: Record<number, number[]>; costs?: Record<number, number | null> } = {}): EarnedValueInput {
  const sched = scheduleProject({ tasks, deps: [], projectStart: MON });
  if ('cycle' in sched) throw new Error('cycle');
  const people = new Map(Object.entries(o.people ?? Object.fromEntries(tasks.map((t) => [t.id, [9]]))).map(([k, v]) => [Number(k), v]));
  const rates = o.rates ?? new Map([[9, 100]]);
  const snapshot = o.snapshot ?? new Map(tasks.filter((t) => !sched.tasks.get(t.id)!.summary).map((t) => {
    const s = sched.tasks.get(t.id)!;
    const cost = o.costs && t.id in o.costs ? o.costs[t.id] : plannedCost(t, people.get(t.id) ?? [], rates);
    return [t.id, { start: s.start, end: s.end, duration: t.duration, cost }];
  }));
  return { tasks, schedule: sched.tasks, people, rates, snapshot, statusDate: o.statusDate ?? WED, currency: 'EUR' };
}
const ok = (r: ReturnType<typeof earnedValue>): EarnedValue => {
  if ('missing' in r) throw new Error(`missing ${r.missing}`);
  return r;
};

describe('planned cost', () => {
  it('is length × day rates, plus fixed cost; none without either', () => {
    expect(plannedCost({ duration: 5 }, [9], new Map([[9, 100]]))).toBe(500);
    expect(plannedCost({ duration: 5, fixed_cost: 250 }, [9, 8], new Map([[9, 100], [8, 50]]))).toBe(1000);
    expect(plannedCost({ duration: 5, fixed_cost: 250 }, [], new Map())).toBe(250);
    expect(plannedCost({ duration: 5 }, [7], new Map([[9, 100]]))).toBeNull();
  });

  it('spreads evenly over working days, and a milestone lands at its end', () => {
    const span = { start: MON, end: '2026-03-06', duration: 5 };
    expect([plannedShare(span, '2026-02-27'), plannedShare(span, WED), plannedShare(span, '2026-03-06')]).toEqual([0, 0.6, 1]);
    expect(plannedShare({ start: WED, end: WED, duration: 0 }, '2026-03-03')).toBe(0);
    expect(plannedShare({ start: WED, end: WED, duration: 0 }, WED)).toBe(1);
  });
});

describe('earned value', () => {
  it('reads SPI = CPI = 1 for work exactly on its baseline', () => {
    // Five days at 100; by Wednesday three are planned, done and spent.
    const r = ok(earnedValue(input([task(1, 5, { status: 'in_progress', actual_start: MON, progress: 60 })])));
    expect([r.bac, r.pv, r.ev, r.ac]).toEqual([500, 300, 300, 300]);
    expect([r.spi, r.cpi, r.eac]).toEqual([1, 1, 500]);
    expect(r.verdict.schedule.word).toBe('on');
    expect(r.verdict.cost.word).toBe('on');
    expect(r.verdict.forecast).toBe('Heading for €500, on the €500 budget.');
    expect(r.estimated).toBe(1);
  });

  it('says behind and over in words, with the money, from a typed actual cost', () => {
    const r = ok(earnedValue(input([task(1, 5, { status: 'in_progress', actual_start: MON, progress: 40, actual_cost: 250 })])));
    expect([r.pv, r.ev, r.ac]).toEqual([300, 200, 250]);
    expect(r.verdict.schedule).toEqual({ word: 'behind', text: '33% behind schedule. Work worth €100 that was planned by now hasn’t been done.' });
    expect(r.verdict.cost).toEqual({ word: 'over', text: '20% over budget. The work done so far cost €50 more than planned.' });
    expect(r.eac).toBe(625);
    expect(r.verdict.forecast).toBe('Heading for €625, €125 over the €500 budget at this rate.');
    expect([r.typed, r.estimated]).toEqual([1, 0]);
  });

  it('needs a baseline, and some cost in it', () => {
    expect(earnedValue({ ...input([task(1, 5)]), snapshot: new Map() })).toEqual({ missing: 'baseline' });
    expect(earnedValue(input([task(1, 5)], { rates: new Map() }))).toEqual({ missing: 'cost' });
  });

  it('leaves out work added after the baseline, and says how much', () => {
    const base = input([task(1, 5)]);
    const r = ok(earnedValue({ ...base, tasks: [task(1, 5), task(2, 3)], people: new Map([[1, [9]], [2, [9]]]) }));
    expect(r.bac).toBe(500);
    expect(r.outside).toBe(1);
  });

  it('budgets at today’s cost a task the baseline kept no cost for', () => {
    const r = ok(earnedValue(input([task(1, 5)], { costs: { 1: null } })));
    expect(r.bac).toBe(500);
    expect(r.from_plan).toBe(1);
  });

  it('sums summaries from their working tasks', () => {
    const tasks = [task(10, 0, { name: 'Build' }), task(1, 5, { parent_id: 10 }), task(2, 2, { parent_id: 10, status: 'done', actual_start: MON, actual_end: '2026-03-03' })];
    const r = ok(earnedValue(input(tasks)));
    expect(r.summaries).toHaveLength(1);
    expect(r.summaries[0]).toMatchObject({ id: 10, name: 'Build', bac: 700 });
    expect(r.summaries[0].ev).toBe(r.ev);
  });

  it('draws planned value weekly, rising to the budget, and bounded', () => {
    const r = ok(earnedValue(input([task(1, 30)], { statusDate: MON })));
    expect(r.series[0].pv).toBeGreaterThan(0);
    expect(r.series.at(-1)).toEqual({ date: r.finish, pv: 3000 });
    for (let i = 1; i < r.series.length; i++) expect(r.series[i].pv).toBeGreaterThanOrEqual(r.series[i - 1].pv);
    expect(r.series.length).toBeLessThanOrEqual(8);
  });

  it('counts a plan’s cost bottom-up', () => {
    const i = input([task(1, 5), task(2, 2, { fixed_cost: 50 })]);
    expect(planCost(i)).toBe(750);
  });

  it('writes money in the plan’s currency, whole units', () => {
    expect(formatMoney(1234.6, 'EUR')).toBe('€1,235');
    expect(formatMoney(5000, 'USD')).toBe('US$5,000');
    expect(formatMoney(12, 'XXZ')).toMatch(/^XXZ\s12$/);
  });
});
