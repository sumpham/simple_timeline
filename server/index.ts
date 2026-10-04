import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { router } from './routes.ts';
import { all, DB_PATH, transaction } from './db.ts';
import { replan } from './plan.ts';
import { accessEnabled, accessGate } from './access.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 5173);

// Summaries store their rolled-up status and actuals (server/plan.ts). Replan the
// plans that have any, so rows written before that read right. Idempotent.
transaction(() => {
  for (const { id } of all<{ id: number }>('SELECT DISTINCT project_id AS id FROM task WHERE parent_id IS NOT NULL')) {
    try { replan(id); } catch (e) { console.warn(`could not replan project ${id}: ${(e as Error).message}`); }
  }
});

const app = express();
// Behind a proxy (HTTPS tunnel), trust it so the cookie can be marked Secure.
app.set('trust proxy', 'loopback');
app.use(accessGate());
app.use(express.json());
app.use('/api', router);

// In production the API also serves the built client; in dev, Vite does that
// and proxies /api here.
const dist = join(root, 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    // Only a navigation falls back to the app shell. A request for a file that
    // is not there must 404, or a broken asset path looks like a 200 of HTML.
    if (extname(req.path)) return next();
    res.sendFile(join(dist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`simple timeline api  http://localhost:${PORT}`);
  console.log(`database             ${DB_PATH}`);
  console.log(`access key           ${accessEnabled ? 'required (ACCESS_GATE=on)' : 'off (ACCESS_GATE is not on)'}`);
});
