/**
 * Demo data. Deliberately contains double-bookings -- an empty board proves nothing
 * about the feature the tool exists for.
 */
import { db, ensureResources, run, setTaskResources, transaction } from './db.ts';
import { replan } from './plan.ts';
import { plannedCosts } from './money.ts';
import { addWorkingDays, snapToWorkingDay, today } from '../shared/dates.ts';
import type { ISODate } from '../shared/types.ts';

const base = today();
/** A date `n` working days from today, snapped onto a working day. */
const d = (n: number): ISODate => addWorkingDays(snapToWorkingDay(base), n);

const TEAMS = [
  {
    name: 'Payments Platform', code: 'PAY',
    envs: [
      { name: 'SIT', kind: 'SIT', capacity: 1 },
      { name: 'UAT', kind: 'UAT', capacity: 1 },
      { name: 'NFT', kind: 'NFT', capacity: 1 },
      { name: 'PROD', kind: 'PROD', capacity: 1 },
    ],
    projects: [
      {
        name: 'Card tokenisation R2', priority: 'critical', owner: 'Mai', status: 'in_progress',
        start: -8, target: 20,
        // Two saved plans that each promised an earlier finish: the slip chart climbs.
        baselines: [{ name: 'Approved plan', earlier: 6, saved: -30 }, { name: 'After CR-12', earlier: 3, saved: -14 }],
        // A plan whose UAT work outgrows the UAT booking made by hand, so the booking stretches.
        tasks: [
          // A licence bought outright, and a vault that came in over budget: earned value has a story.
          { key: 'hsm', name: 'Deploy HSM stub', dur: 2, status: 'done', actual: [-8, -7], fixed_cost: 4000 },
          { key: 'vault', name: 'Build card vault', dur: 4, after: ['hsm'], status: 'done', actual: [-6, -3], who: ['Mai'], actual_cost: 2600 },
          { key: 'sit', name: 'Vault regression in SIT', env: 'SIT', dur: 8, after: ['vault'], status: 'in_progress', actual: [-2], who: ['Tuan', 'Lan'], progress: 15 },
          { key: 'pen', name: 'Pen test scoping', dur: 2, after: ['vault'], who: ['Mai'] },
          { key: 'nft', name: 'Tokenisation soak test', env: 'NFT', dur: 5, after: ['sit'] },
          { key: 'uat', name: 'Merchant UAT', env: 'UAT', dur: 12, after: [['sit', 1]], who: ['Lan'] },
          { key: 'live', name: 'Go / no-go', dur: 0, after: ['nft', 'uat'] },
        ],
        bookings: [
          { env: 'SIT', kind: 'SIT', start: -6, end: 6, note: 'Needs the HSM stub deployed before day one.' },
          { env: 'UAT', kind: 'UAT', start: 8, end: 18 },
          { env: 'PROD', kind: 'CUSTOM', start: 20, end: 20, marker: 'flag', note: 'Go / no-go with ops.' },
          { env: 'NFT', kind: 'NFT', start: 14, end: 19 },
          { env: 'PROD', kind: 'RELEASE', start: 22, end: 22 },
        ],
      },
      {
        // Collides with tokenisation in SIT -- the headline conflict on load.
        name: 'Settlement rewrite', priority: 'high', owner: 'Khoa', status: 'in_progress',
        bookings: [
          { env: 'SIT', kind: 'SIT', start: 2, end: 12 },
          { env: 'UAT', kind: 'UAT', start: 15, end: 24 },
          { env: 'PROD', kind: 'RELEASE', start: 28, end: 28 },
          { env: 'NFT', kind: 'CUSTOM', start: 25, end: 27, marker: 'star', note: 'Soak test with the bank simulator.' },
        ],
      },
      {
        // And a second, quieter UAT collision later in the window.
        name: 'Refund API v3', priority: 'normal', owner: 'Linh', status: 'planned',
        start: 10,
        // No NFT booking by hand: the load test books NFT itself and lands on tokenisation's soak.
        tasks: [
          { key: 'api', name: 'Refund endpoints', dur: 5, who: ['Linh', 'Tuan'] },
          { key: 'load', name: 'Refund load test', env: 'NFT', dur: 5, after: ['api'], not_before: 16 },
          // Promised to partners before the work allows: a missed deadline on load.
          { key: 'docs', name: 'Partner docs', dur: 3, after: ['api'], who: ['Linh'], deadline: 16 },
          // Tuan on two things at once, with float to spare: Level people has a move within it.
          { key: 'sandbox', name: 'Partner sandbox', dur: 3, who: ['Tuan'] },
        ],
        bookings: [
          { env: 'SIT', kind: 'SIT', start: 16, end: 23 },
          { env: 'UAT', kind: 'UAT', start: 21, end: 30 },
          { env: 'PENTEST', kind: 'PENTEST', start: 32, end: 35, create_env: 'PENTEST' },
          { env: 'PROD', kind: 'RELEASE', start: 38, end: 38 },
        ],
      },
      {
        name: 'Fraud scoring tune', priority: 'low', owner: 'Duc', status: 'planned',
        bookings: [
          { env: 'SIT', kind: 'SIT', start: 30, end: 36, confidence: 'tentative' },
          { env: 'UAT', kind: 'UAT', start: 40, end: 45, confidence: 'tentative' },
        ],
      },
    ],
  },
  {
    name: 'Core Banking', code: 'CBK',
    envs: [
      { name: 'SIT', kind: 'SIT', capacity: 2 },
      { name: 'UAT', kind: 'UAT', capacity: 1 },
      { name: 'PROD', kind: 'PROD', capacity: 1 },
    ],
    projects: [
      {
        name: 'Ledger migration', priority: 'critical', owner: 'Trang', status: 'in_progress',
        bookings: [
          { env: 'SIT', kind: 'SIT', start: -10, end: 4 },
          { env: 'UAT', kind: 'UAT', start: 7, end: 20 },
          { env: 'PROD', kind: 'RELEASE', start: 25, end: 25 },
        ],
      },
      {
        // Shares SIT legitimately: this team's SIT has capacity 2, so no conflict.
        name: 'Interest engine', priority: 'normal', owner: 'Nam', status: 'in_progress',
        bookings: [
          { env: 'SIT', kind: 'SIT', start: -4, end: 8 },
          { env: 'UAT', kind: 'UAT', start: 18, end: 28 },
        ],
      },
      {
        name: 'Statement redesign', priority: 'normal', owner: 'Ha', status: 'planned',
        bookings: [
          { env: 'SIT', kind: 'SIT', start: 1, end: 10 },
          { env: 'PROD', kind: 'RELEASE', start: 33, end: 33 },
        ],
      },
    ],
  },
  {
    name: 'Customer Channels', code: 'CHN',
    envs: [
      { name: 'SIT', kind: 'SIT', capacity: 1 },
      { name: 'UAT', kind: 'UAT', capacity: 1 },
      { name: 'PROD', kind: 'PROD', capacity: 1 },
    ],
    projects: [
      {
        name: 'Mobile app 5.0', priority: 'high', owner: 'Quan', status: 'in_progress',
        start: -2,
        // SIT work finished early, but the SIT booking runs on: the board offers to release it.
        tasks: [
          { key: 'smoke', name: 'SIT smoke suite', env: 'SIT', dur: 2, status: 'done', actual: [-2, -1] },
          { key: 'fix', name: 'Fix SIT findings', dur: 3, after: ['smoke'] },
          { key: 'uat', name: 'Store review build in UAT', env: 'UAT', dur: 6, after: ['fix'], not_before: 12 },
        ],
        bookings: [
          { env: 'SIT', kind: 'SIT', start: -2, end: 9 },
          { env: 'UAT', kind: 'UAT', start: 12, end: 22 },
          { env: 'PROD', kind: 'RELEASE', start: 26, end: 26 },
        ],
      },
      {
        name: 'Web onboarding', priority: 'normal', owner: 'Yen', status: 'planned',
        bookings: [
          { env: 'SIT', kind: 'SIT', start: 13, end: 21 },
          { env: 'UAT', kind: 'UAT', start: 24, end: 31 },
        ],
      },
    ],
  },
] as const;

type SeedTask = {
  key: string; name: string; dur: number; env?: string; status?: string; who?: readonly string[];
  after?: readonly (string | readonly [string, number])[]; not_before?: number; actual?: readonly number[];
  deadline?: number;
  fixed_cost?: number;
  actual_cost?: number;
  progress?: number;
};

/** Day rates for the people the seed names, in the projects' currency (EUR). */
const RATES: Record<string, number> = { Mai: 520, Tuan: 480, Lan: 450, Linh: 500 };

const HOLIDAYS = [
  { date: addWorkingDays(snapToWorkingDay(base), 11), name: 'Company day' },
];

transaction(() => {
  for (const table of ['audit_log', 'task_baseline', 'baseline', 'task_resource', 'resource', 'task_dependency', 'task', 'booking', 'project', 'environment', 'holiday', 'team']) {
    run(`DELETE FROM ${table}`);
  }
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('team','environment','project','booking','task','resource','baseline')");

  for (const h of HOLIDAYS) run('INSERT OR REPLACE INTO holiday (date, name) VALUES (?, ?)', h.date, h.name);

  for (const team of TEAMS) {
    const teamId = Number(run('INSERT INTO team (name, code) VALUES (?, ?)', team.name, team.code).lastInsertRowid);

    const envIds = new Map<string, number>();
    team.envs.forEach((env, i) => {
      const id = run(
        'INSERT INTO environment (team_id, name, kind, capacity, sort_order) VALUES (?, ?, ?, ?, ?)',
        teamId, env.name, env.kind, env.capacity, i,
      ).lastInsertRowid;
      envIds.set(env.name, Number(id));
    });

    for (const project of team.projects) {
      const projectId = Number(run(
        'INSERT INTO project (team_id, name, status, priority, owner, start_date, target_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
        teamId, project.name, project.status, project.priority, project.owner,
        'start' in project ? d(project.start) : null, 'target' in project ? d(project.target) : null,
      ).lastInsertRowid);

      for (const b of project.bookings) {
        let envId = envIds.get(b.env);
        if (envId == null) {
          // A project may introduce an environment the team did not start with.
          const id = run(
            'INSERT INTO environment (team_id, name, kind, capacity, sort_order) VALUES (?, ?, ?, ?, ?)',
            teamId, b.env, b.env, 1, envIds.size,
          ).lastInsertRowid;
          envId = Number(id);
          envIds.set(b.env, envId);
        }
        run(
          `INSERT INTO booking (project_id, environment_id, kind, start_date, end_date, confidence, note, marker,
                                manual_start, manual_end)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          projectId, envId, b.kind, d(b.start), d(b.end),
          'confidence' in b ? b.confidence : 'committed',
          'note' in b ? b.note : null,
          'marker' in b ? b.marker : null,
          d(b.start), d(b.end),
        );
      }

      if (!('tasks' in project)) continue;
      const taskIds = new Map<string, number>();
      project.tasks.forEach((t: SeedTask, i) => {
        const actual = t.actual ?? [];
        taskIds.set(t.key, Number(run(
          `INSERT INTO task (project_id, environment_id, name, duration, status, not_before, sort_order,
                             actual_start, actual_end, code, deadline, fixed_cost, actual_cost, progress)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          projectId, t.env ? envIds.get(t.env) : null, t.name, t.dur, t.status ?? 'todo',
          t.not_before != null ? d(t.not_before) : null, i,
          actual[0] != null ? d(actual[0]) : null, actual[1] != null ? d(actual[1]) : null, i + 1,
          t.deadline != null ? d(t.deadline) : null, t.fixed_cost ?? null, t.actual_cost ?? null, t.progress ?? null,
        ).lastInsertRowid));
      });
      for (const t of project.tasks as readonly SeedTask[]) {
        if (t.who) setTaskResources(taskIds.get(t.key)!, ensureResources(t.who));
        for (const name of t.who ?? []) if (RATES[name] != null) run('UPDATE resource SET rate = ? WHERE name = ?', RATES[name], name);
        for (const a of t.after ?? []) {
          const [key, lag] = typeof a === 'string' ? [a, 0] : a;
          run('INSERT INTO task_dependency (predecessor_id, successor_id, lag) VALUES (?, ?, ?)',
            taskIds.get(key), taskIds.get(t.key), lag);
        }
      }
      replan(projectId);

      // Saved baselines: the plan as it now stands, shifted earlier, saved in the past.
      for (const b of ('baselines' in project ? project.baselines : []) as readonly { name: string; earlier: number; saved: number }[]) {
        const tasks = db.prepare('SELECT id, start_date, end_date, duration FROM task WHERE project_id = ? AND start_date IS NOT NULL').all(projectId) as
          { id: number; start_date: ISODate; end_date: ISODate; duration: number }[];
        const back = (x: ISODate) => addWorkingDays(x, -b.earlier);
        const finish = tasks.reduce((m, t) => (t.end_date > m ? t.end_date : m), tasks[0].end_date);
        const id = Number(run('INSERT INTO baseline (project_id, name, saved_at, finish) VALUES (?, ?, ?, ?)',
          projectId, b.name, `${d(b.saved)} 09:00:00`, back(finish)).lastInsertRowid);
        const costs = plannedCosts(projectId);
        for (const t of tasks) {
          run('INSERT INTO task_baseline (baseline_id, task_id, project_id, start_date, end_date, duration, cost) VALUES (?, ?, ?, ?, ?, ?, ?)',
            id, t.id, projectId, back(t.start_date), back(t.end_date), t.duration, costs.get(t.id) ?? null);
        }
        run('UPDATE project SET compare_baseline_id = COALESCE(compare_baseline_id, ?) WHERE id = ?', id, projectId);
      }
    }
  }
});

console.log('Seeded 3 teams with deliberate double-bookings in Payments SIT and UAT, and task plans on three projects.');
