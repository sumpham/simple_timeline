// Runs the API and the Vite dev server together, and takes both down as one.
import { spawn } from 'node:child_process';

const procs = [
  spawn('node', ['--no-warnings=ExperimentalWarning', 'server/index.ts'], {
    stdio: 'inherit',
    env: { ...process.env, PORT: process.env.API_PORT ?? '5174' },
  }),
  spawn('npx', ['vite'], { stdio: 'inherit', env: process.env }),
];

const shutdown = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
for (const p of procs) p.on('exit', shutdown);
