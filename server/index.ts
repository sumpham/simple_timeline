import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { router } from './routes.ts';
import { DB_PATH } from './db.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 5173);

const app = express();
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
});
