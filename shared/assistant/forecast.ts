import type { HolidaySet } from '../dates.ts';
import { rangeOf } from '../estimates.ts';
import { earliestStart, forwardPass, indexNetwork, type IndexNetwork } from '../schedule.ts';
import type { ISODate, Task, TaskDependency } from '../types.ts';
import { seededRandom, seedOf, type Random } from './random.ts';

/**
 * Schedule risk analysis by Monte Carlo (reqs/smart_assistant.md §5.3; AACE RP
 * 57R-09). Each run samples every unfinished task's duration from its range and
 * runs the scheduler's own forward pass, so a range of zero width gives the CPM
 * finish exactly.
 *
 * The status date is the data date: work not finished cannot be forecast to
 * happen before it. An unstarted task is floored at the status date; a started
 * one keeps its actual start and runs its remaining work from the status date.
 *
 * Pure, seeded and bounded: the same plan on the same status date gives the same
 * forecast, and the run count is capped.
 */

export const FORECAST_RUNS_MAX = 10000;
/** A task is reported by the criticality index from this share of runs up. */
const CRITICALITY_FLOOR = 0.05;
const TOP = 8;

export type ForecastInput = {
  tasks: readonly Task[];
  deps: readonly TaskDependency[];
  projectStart: ISODate;
  statusDate: ISODate;
  target?: ISODate | null;
  runs: number;
  holidays?: HolidaySet;
  /** Pace per in-progress task (earned schedule), for a pessimistic tail when it is slow. */
  pace?: ReadonlyMap<number, number | null>;
};

export type Forecast = {
  runs: number;
  /** The CPM finish on planned durations, ignoring the status date. */
  planned: ISODate;
  /** The finish with every task on its planned duration but nothing before the status date. */
  deterministic: ISODate;
  p50: ISODate;
  p80: ISODate;
  p90: ISODate;
  /** Share of runs finishing on or before the target; null with no target. */
  on_time: number | null;
  /** How often each task was on the path that set the finish. Highest first, above a floor. */
  criticality: { id: number; index: number }[];
  /** Tasks whose duration moves the finish most (correlation with it), highest first. */
  sensitivity: { id: number; correlation: number }[];
  /** Unfinished working tasks with a typed best or worst case, and those running on the default range. */
  estimated: number;
  defaulted: number;
  /** Of those on defaults, how many are critical in the plan. */
  defaulted_critical: number[];
};

/** A triangular sample on [low, high] peaking at mode, by the inverse of its distribution. */
export function triangular(r: Random, low: number, mode: number, high: number): number {
  if (high <= low) return mode;
  const u = r();
  const cut = (mode - low) / (high - low);
  return u < cut
    ? low + Math.sqrt(u * (high - low) * (mode - low))
    : high - Math.sqrt((1 - u) * (high - low) * (high - mode));
}

type Sampler = { low: number; mode: number; high: number; typed: boolean; fixed: boolean };

export function forecast(input: ForecastInput, critical: ReadonlySet<number> = new Set()): Forecast | null {
  const holidays = input.holidays;
  const base = indexNetwork({ tasks: input.tasks, deps: input.deps, projectStart: input.projectStart, holidays });
  if ('cycle' in base || !base.ids.length) return null;
  const runs = Math.max(1, Math.min(FORECAST_RUNS_MAX, Math.floor(input.runs)));
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const statusIndex = base.indexOf(input.statusDate);

  // The network as of the status date, and each position's range of total duration.
  const state: IndexNetwork['state'] = [];
  const samplers: Sampler[] = [];
  base.ids.forEach((id, i) => {
    const t = byId.get(id)!;
    const st = base.state[i];
    const planned = base.durations[i];
    if (st.kind === 'fixed' || planned === 0) {
      state.push(st.kind === 'free' ? { kind: 'free', floor: Math.max(st.floor ?? 0, statusIndex) } : st);
      samplers.push({ low: planned, mode: planned, high: planned, typed: false, fixed: true });
      return;
    }
    const range = rangeOf(t);
    if (st.kind === 'started') {
      // Work already done is spent; what is left runs from the status date on.
      const elapsed = Math.max(0, statusIndex - st.es);
      const left = remainingOf(t, planned, st.es, statusIndex);
      const share = planned > 0 ? left / planned : 0;
      const spi = input.pace?.get(id) ?? null;
      const high = range.typed && t.duration_high != null ? range.high * share
        : Math.max(left * (range.high / Math.max(1, range.mode)), spi && spi > 0 && spi < 1 ? left / spi : 0);
      const low = range.low * share;
      state.push(st);
      samplers.push({ low: elapsed + low, mode: elapsed + left, high: elapsed + Math.max(high, left), typed: range.typed, fixed: false });
      return;
    }
    state.push({ kind: 'free', floor: Math.max(st.floor ?? 0, statusIndex) });
    samplers.push({ ...range, fixed: false });
  });
  const net: IndexNetwork = { ...base, state };

  const dateOfFinish = memo((i: number) => base.dateOf(Math.max(0, Math.ceil(i - 1e-9) - 1)));
  const planned = dateOfFinish(forwardPass(base).finish);
  const deterministic = dateOfFinish(forwardPass(net, samplers.map((s) => s.mode)).finish);

  // Seeded from what the forecast depends on, so it is stable until the plan or the date moves.
  const seed = seedOf(JSON.stringify([input.statusDate, runs, base.ids, samplers.map((s) => [s.low, s.mode, s.high]), base.preds, state]));
  const random = seededRandom(seed);

  const n = base.ids.length;
  const finishes = new Float64Array(runs);
  const onPath = new Uint32Array(n);
  const sx = new Float64Array(n);
  const sxx = new Float64Array(n);
  const sxf = new Float64Array(n);
  let sf = 0;
  let sff = 0;
  const durations = new Float64Array(n);

  for (let r = 0; r < runs; r++) {
    for (let i = 0; i < n; i++) {
      const s = samplers[i];
      durations[i] = s.fixed ? s.mode : triangular(random, s.low, s.mode, s.high);
    }
    const f = forwardPass(net, durations);
    finishes[r] = f.finish;
    sf += f.finish;
    sff += f.finish * f.finish;
    for (let i = 0; i < n; i++) {
      sx[i] += durations[i];
      sxx[i] += durations[i] * durations[i];
      sxf[i] += durations[i] * f.finish;
    }
    markDrivingPath(net, durations, f, onPath);
  }

  const sorted = [...finishes].sort((a, b) => a - b);
  const at = (q: number) => dateOfFinish(sorted[Math.min(runs - 1, Math.max(0, Math.ceil(q * runs) - 1))]);
  const target = input.target ?? null;
  let onTime = 0;
  if (target) for (const x of finishes) if (dateOfFinish(x) <= target) onTime++;

  const varF = sff / runs - (sf / runs) ** 2;
  const sensitivity: Forecast['sensitivity'] = [];
  for (let i = 0; i < n; i++) {
    const varX = sxx[i] / runs - (sx[i] / runs) ** 2;
    if (varX <= 1e-9 || varF <= 1e-9) continue;
    const cov = sxf[i] / runs - (sx[i] / runs) * (sf / runs);
    const correlation = cov / Math.sqrt(varX * varF);
    if (correlation > 0.05) sensitivity.push({ id: base.ids[i], correlation: round2(correlation) });
  }
  sensitivity.sort((a, b) => b.correlation - a.correlation || a.id - b.id);

  const criticality = base.ids
    .map((id, i) => ({ id, index: round2(onPath[i] / runs) }))
    .filter((c, i) => !samplers[i].fixed && c.index >= CRITICALITY_FLOOR)
    .sort((a, b) => b.index - a.index || a.id - b.id);

  const open = base.ids.map((id, i) => ({ id, s: samplers[i] })).filter((x) => !x.s.fixed);
  const defaulted = open.filter((x) => !x.s.typed);

  return {
    runs,
    planned,
    deterministic,
    p50: at(0.5),
    p80: at(0.8),
    p90: at(0.9),
    on_time: target ? round2(onTime / runs) : null,
    criticality: criticality.slice(0, TOP),
    sensitivity: sensitivity.slice(0, TOP),
    estimated: open.length - defaulted.length,
    defaulted: defaulted.length,
    defaulted_critical: defaulted.filter((x) => critical.has(x.id)).map((x) => x.id),
  };
}

/** Working days of a started task still to do on the status date; at least one while it is not done. */
function remainingOf(t: Task, planned: number, startIndex: number, statusIndex: number): number {
  if (t.progress != null) return Math.max(1, Math.ceil(planned * (1 - Math.min(100, Math.max(0, t.progress)) / 100)));
  return Math.max(1, planned - Math.max(0, statusIndex - startIndex));
}

/**
 * Walk back from the task that set the finish along the links that held each
 * task's start, marking every task on the way: that run's critical path. One
 * step per task at most, so it always ends.
 */
function markDrivingPath(net: IndexNetwork, durations: ArrayLike<number>, f: { es: number[]; ef: number[]; finish: number }, onPath: Uint32Array) {
  let cur = -1;
  for (let i = 0; i < f.ef.length; i++) if (cur < 0 || f.ef[i] > f.ef[cur]) cur = i;
  for (let guard = 0; cur >= 0 && guard <= f.ef.length; guard++) {
    onPath[cur]++;
    if (net.state[cur].kind !== 'free') return;
    let next = -1;
    for (const p of net.preds[cur]) {
      const at = earliestStart(p.type, f.es[p.from], f.ef[p.from], p.lag, Math.max(0, durations[cur]));
      if (Math.abs(at - f.es[cur]) < 1e-9) { next = p.from; break; }
    }
    cur = next;
  }
}

function memo<T>(fn: (i: number) => T): (i: number) => T {
  const cache = new Map<number, T>();
  return (i) => {
    const key = Math.max(0, Math.ceil(i - 1e-9));
    let v = cache.get(key);
    if (v === undefined) { v = fn(i); cache.set(key, v); }
    return v;
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
