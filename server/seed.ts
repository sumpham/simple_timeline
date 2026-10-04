/**
 * Demo data. Deliberately contains double-bookings -- an empty board proves nothing
 * about the feature the tool exists for.
 */
import { db, ensureResources, run, setTaskResources, transaction } from './db.ts';
import { replan } from './plan.ts';
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
        // A plan whose UAT work outgrows the UAT booking made by hand, so the booking stretches.
        tasks: [
          { key: 'hsm', name: 'Deploy HSM stub', dur: 2, status: 'done', actual: [-8, -7] },
          { key: 'vault', name: 'Build card vault', dur: 4, after: ['hsm'], status: 'done', actual: [-6, -3], who: ['Mai'] },
          { key: 'sit', name: 'Vault regression in SIT', env: 'SIT', dur: 8, after: ['vault'], status: 'in_progress', actual: [-2], who: ['Tuan', 'Lan'] },
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
};

const HOLIDAYS = [
  { date: addWorkingDays(snapToWorkingDay(base), 11), name: 'Company day' },
];

transaction(() => {
  for (const table of ['audit_log', 'task_resource', 'resource', 'task_dependency', 'task', 'booking', 'project', 'environment', 'holiday', 'team']) {
    run(`DELETE FROM ${table}`);
  }
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('team','environment','project','booking','task','resource')");

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
                             actual_start, actual_end, code, deadline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          projectId, t.env ? envIds.get(t.env) : null, t.name, t.dur, t.status ?? 'todo',
          t.not_before != null ? d(t.not_before) : null, i,
          actual[0] != null ? d(actual[0]) : null, actual[1] != null ? d(actual[1]) : null, i + 1,
          t.deadline != null ? d(t.deadline) : null,
        ).lastInsertRowid));
      });
      for (const t of project.tasks as readonly SeedTask[]) {
        if (t.who) setTaskResources(taskIds.get(t.key)!, ensureResources(t.who));
        for (const a of t.after ?? []) {
          const [key, lag] = typeof a === 'string' ? [a, 0] : a;
          run('INSERT INTO task_dependency (predecessor_id, successor_id, lag) VALUES (?, ?, ?)',
            taskIds.get(key), taskIds.get(t.key), lag);
        }
      }
      replan(projectId);
    }
  }
});

console.log('Seeded 3 teams with deliberate double-bookings in Payments SIT and UAT, and task plans on three projects.');
