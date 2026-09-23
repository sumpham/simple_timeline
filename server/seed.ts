/**
 * Demo data. Deliberately contains double-bookings -- an empty board proves nothing
 * about the feature the tool exists for.
 */
import { db, run, transaction } from './db.ts';
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

const HOLIDAYS = [
  { date: addWorkingDays(snapToWorkingDay(base), 11), name: 'Company day' },
];

transaction(() => {
  for (const table of ['audit_log', 'booking', 'project', 'environment', 'holiday', 'team']) {
    run(`DELETE FROM ${table}`);
  }
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('team','environment','project','booking')");

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
        'INSERT INTO project (team_id, name, status, priority, owner) VALUES (?, ?, ?, ?, ?)',
        teamId, project.name, project.status, project.priority, project.owner,
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
          `INSERT INTO booking (project_id, environment_id, kind, start_date, end_date, confidence, note, marker)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          projectId, envId, b.kind, d(b.start), d(b.end),
          'confidence' in b ? b.confidence : 'committed',
          'note' in b ? b.note : null,
          'marker' in b ? b.marker : null,
        );
      }
    }
  }
});

console.log('Seeded 3 teams with deliberate double-bookings in Payments SIT and UAT.');
