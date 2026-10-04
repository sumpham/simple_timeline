import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type RequestHandler } from 'express';

// One shared key, for a board only its owner uses. Set ACCESS_KEY and every
// request needs the key once; after that a cookie remembers this browser for
// 400 days (the longest a browser keeps one). Unset, the board is open, as before.
const KEY = process.env.ACCESS_KEY ?? '';
const COOKIE = 'st_access';
const MAX_AGE_S = 400 * 24 * 60 * 60;

// The cookie holds a hash of the key, not the key. Changing ACCESS_KEY signs
// every browser out.
const token = createHash('sha256').update(`simple-timeline:${KEY}`).digest('hex');

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const cookieOf = (header: string | undefined) => {
  for (const part of (header ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return '';
};

const form = (wrong: boolean) => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>simple timeline</title>
<style>
  body { font: 15px system-ui, sans-serif; display: grid; place-items: center; min-height: 90vh; margin: 0; }
  form { display: grid; gap: 10px; width: min(280px, 90vw); }
  input, button { font: inherit; padding: 8px 10px; }
  p { margin: 0; color: #a33; }
</style>
<form method="post" action="/access">
  <label for="k">Access key</label>
  <input id="k" name="key" type="password" autofocus autocomplete="current-password">
  ${wrong ? '<p>That key is not right.</p>' : ''}
  <button>Open</button>
</form>`;

export const accessEnabled = KEY !== '';

export function accessGate(): RequestHandler {
  const router = express.Router();
  if (!accessEnabled) return router;

  const remember = (res: express.Response, secure: boolean) =>
    res.setHeader('Set-Cookie',
      `${COOKIE}=${token}; Max-Age=${MAX_AGE_S}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);

  router.post('/access', express.urlencoded({ extended: false }), (req, res) => {
    const key = typeof req.body?.key === 'string' ? req.body.key : '';
    if (!same(key, KEY)) return void res.status(401).type('html').send(form(true));
    remember(res, req.secure);
    res.redirect(303, '/');
  });

  router.use((req, res, next) => {
    // Kubernetes probes and the Jenkins smoke test carry no cookie. Both
    // endpoints say only that the server is up and its database answers.
    if (req.path === '/api/healthz' || req.path === '/api/readyz') return next();
    if (same(cookieOf(req.headers.cookie), token)) return next();
    if (req.path.startsWith('/api/')) return void res.status(401).json({ error: 'Access key needed' });
    res.status(401).type('html').send(form(false));
  });

  return router;
}
