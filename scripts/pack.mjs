#!/usr/bin/env node
/**
 * Build here, run there.
 *
 * Produces a zip that needs nothing on the target machine but Node 24+:
 * the client is pre-built, the server runs from TypeScript through Node's own
 * type stripping, SQLite comes from Node core, and the one runtime dependency
 * (express) is installed into the bundle before zipping.
 *
 *   node scripts/pack.mjs [--no-data] [--no-fonts] [--out <path>]
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const includeData = !flag('--no-data');
const includeFonts = !flag('--no-fonts');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const stamp = new Date().toISOString().slice(0, 10);
const outPath = resolve(option('--out', join(root, `simple-timeline-${stamp}.zip`)));

const step = (msg) => console.log(`\x1b[36m›\x1b[0m ${msg}`);
const done = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const warn = (msg) => console.log(`  \x1b[33m!\x1b[0m ${msg}`);

const sh = (cmd, cmdArgs, cwd) =>
  execFileSync(cmd, cmdArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

// ---------------------------------------------------------------- 1. verify

step('Checking the build is sound');
try {
  sh('npx', ['tsc', '--noEmit'], root);
  done('types clean');
} catch (err) {
  console.error('\nTypecheck failed. Fix it before packing:\n');
  console.error(err.stdout || err.message);
  process.exit(1);
}

try {
  sh('npx', ['vitest', 'run'], root);
  done('tests pass');
} catch (err) {
  console.error('\nTests failed. Fix them before packing:\n');
  console.error(err.stdout || err.message);
  process.exit(1);
}

step('Building the client');
sh('npm', ['run', 'build'], root);
done(`dist built (${sizeOf(join(root, 'dist'))})`);

// ---------------------------------------------------------------- 2. stage

const stageRoot = mkdtempSync(join(tmpdir(), 'simple-timeline-pack-'));
const stage = join(stageRoot, 'simple-timeline');
mkdirSync(stage, { recursive: true });

step('Staging runtime files');
for (const entry of ['dist', 'server', 'shared']) {
  cpSync(join(root, entry), join(stage, entry), { recursive: true });
}
for (const doc of ['README.md', 'DESIGN.md', 'reqs.md']) {
  if (existsSync(join(root, doc))) cpSync(join(root, doc), join(stage, doc));
}
cpSync(join(root, 'docs', 'RUNNING.md'), join(stage, 'RUNNING.md'));
done('dist, server, shared, docs');

// The bundle never builds, so it carries only what it runs.
// react/react-dom are already compiled into dist and are not needed here.
writeFileSync(join(stage, 'package.json'), JSON.stringify({
  name: 'simple-timeline',
  version: pkg.version,
  private: true,
  type: 'module',
  engines: { node: '>=24' },
  scripts: {
    start: 'NODE_ENV=production node --no-warnings=ExperimentalWarning server/index.ts',
    seed: 'node --no-warnings=ExperimentalWarning server/seed.ts',
  },
  dependencies: { express: pkg.dependencies.express },
}, null, 2) + '\n');

// ---------------------------------------------------------------- 3. deps

step('Installing production dependencies into the bundle');
try {
  sh('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], stage);
  done(`node_modules ready (${sizeOf(join(stage, 'node_modules'))})`);
} catch (err) {
  console.error('\nCould not install express into the bundle:\n');
  console.error(err.stderr || err.message);
  process.exit(1);
}

// ---------------------------------------------------------------- 4. fonts

if (includeFonts) {
  step('Vendoring fonts so the board looks right without internet');
  try {
    await vendorFonts(join(stage, 'dist'));
  } catch (err) {
    warn(`kept the Google Fonts link instead: ${err.message}`);
    warn('the target will need internet for typography, and falls back to the system sans without it');
  }
}

// ---------------------------------------------------------------- 5. data

const dbPath = join(root, 'data', 'timeline.db');
mkdirSync(join(stage, 'data'), { recursive: true });

if (includeData && existsSync(dbPath)) {
  step('Copying your data');
  try {
    // VACUUM INTO writes a single consistent file, folding in anything still
    // sitting in the write-ahead log. Copying timeline.db alone can lose recent edits.
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const target = join(stage, 'data', 'timeline.db');
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    db.close();

    const counts = summarise(target);
    done(`data/timeline.db — ${counts}`);
  } catch (err) {
    warn(`could not copy the database (${err.message}); the bundle will start empty`);
  }
} else if (includeData) {
  warn('no data/timeline.db here yet; the bundle will start empty');
} else {
  step('Skipping data (--no-data); the bundle will start empty');
}

// ---------------------------------------------------------------- 6. launcher

writeFileSync(join(stage, 'start.command'), `#!/bin/bash
# Double-click this file to start simple timeline.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node is not installed. Install Node 24 or newer from https://nodejs.org, then try again."
  read -r -p "Press return to close."
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 24 ]; then
  echo "This needs Node 24 or newer. You have $(node -v)."
  echo "Install a newer Node from https://nodejs.org, then try again."
  read -r -p "Press return to close."
  exit 1
fi

PORT="\${PORT:-5173}"
echo "Starting simple timeline on http://localhost:$PORT"
echo "Leave this window open. Press Control-C to stop."
( sleep 2 && open "http://localhost:$PORT" ) &
NODE_ENV=production PORT="$PORT" exec node --no-warnings=ExperimentalWarning server/index.ts
`);

// A .command file only opens on double-click when it is executable.
sh('chmod', ['+x', join(stage, 'start.command')]);
done('start.command (double-clickable)');

// ---------------------------------------------------------------- 7. zip

step('Zipping');
rmSync(outPath, { force: true });
// ditto is the macOS-native zipper and keeps the enclosing folder intact.
sh('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', stage, outPath]);
rmSync(stageRoot, { recursive: true, force: true });

const mb = (statSync(outPath).size / 1024 / 1024).toFixed(1);
console.log(`\n\x1b[32mPacked\x1b[0m ${outPath}  (${mb} MB)`);
console.log(`\nCopy it to the other Mac, unzip, and either double-click start.command`);
console.log(`or run:  cd simple-timeline && npm start`);
console.log(`Setup notes are in RUNNING.md inside the bundle.\n`);

// ---------------------------------------------------------------- helpers

function sizeOf(path) {
  return sh('du', ['-sh', path]).trim().split('\t')[0];
}

function summarise(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const one = (sql) => Number(Object.values({ ...db.prepare(sql).get() })[0] ?? 0);
  const parts = [
    `${one('SELECT COUNT(*) FROM team')} teams`,
    `${one('SELECT COUNT(*) FROM project')} projects`,
    `${one('SELECT COUNT(*) FROM booking')} bookings`,
  ];
  db.close();
  return parts.join(', ');
}

/**
 * Replaces the Google Fonts stylesheet with local woff2 files, keeping the
 * unicode-range subsets so Vietnamese names still render with the real face.
 */
async function vendorFonts(distDir) {
  const cssUrl = 'https://fonts.googleapis.com/css2'
    + '?family=Archivo:wght@400;500;600;700'
    + '&family=Archivo+Narrow:wght@500;600;700&display=swap';

  // Google serves woff2 only to browsers that advertise support.
  const res = await fetch(cssUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`font CSS request returned ${res.status}`);
  let css = await res.text();

  const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]))];
  if (!urls.length) throw new Error('no font files found in the stylesheet');

  const fontsDir = join(distDir, 'fonts');
  mkdirSync(fontsDir, { recursive: true });

  let bytes = 0;
  for (const url of urls) {
    const file = url.split('/').pop().split('?')[0];
    const fontRes = await fetch(url);
    if (!fontRes.ok) throw new Error(`could not download ${file}`);
    const buf = Buffer.from(await fontRes.arrayBuffer());
    writeFileSync(join(fontsDir, file), buf);
    bytes += buf.length;
    // fonts.css lives in the same folder as the files, so the reference is bare.
    css = css.split(url).join(file);
  }

  writeFileSync(join(fontsDir, 'fonts.css'), css);

  // Swap the three CDN <link> tags for the local stylesheet.
  const indexPath = join(distDir, 'index.html');
  const html = readFileSync(indexPath, 'utf8')
    .replace(/\s*<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com"[^>]*>/g, '')
    .replace(/\s*<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com"[^>]*>/g, '')
    .replace(/\s*<link[^>]*fonts\.googleapis\.com\/css2[^>]*>/g,
             '\n    <link rel="stylesheet" href="/fonts/fonts.css">');
  writeFileSync(indexPath, html);

  done(`${urls.length} font files vendored (${(bytes / 1024).toFixed(0)} KB), no internet needed`);
}
