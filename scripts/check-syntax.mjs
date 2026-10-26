#!/usr/bin/env node
/**
 * Static checks without running anything:
 *  - syntax of every poller module, dashboard module, worker and the service worker;
 *  - every named import between dashboard modules resolves to an export;
 *  - every dashboard file is in the service worker's offline list;
 *  - JSON config parses.
 */
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

async function walk(dir, ext) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'fixtures' && entry.name !== 'vendor') out.push(...(await walk(full, ext)));
    } else if (entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

let failed = 0;
const dashboard = await walk('src', '.js');
for (const file of [...await walk('poller', '.mjs'), ...await walk('scripts', '.mjs'), ...dashboard, 'sw.js']) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`syntax error in ${file}\n${r.stderr}`);
  }
}
/* Named imports between dashboard modules must match an export (a typo would only fail in the browser). */
const exportsOf = new Map();
for (const file of dashboard) {
  const text = await readFile(file, 'utf8');
  exportsOf.set(path.resolve(file), new Set([...text.matchAll(/^export (?:async )?(?:const|let|function\*?|class) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])));
}
/* Shared modules outside src/ (poller/lib/*.mjs used by the dashboard) are read on demand. */
async function exportsFor(target) {
  if (!exportsOf.has(target)) {
    try {
      const text = await readFile(target, 'utf8');
      exportsOf.set(target, new Set([...text.matchAll(/^export (?:async )?(?:const|let|function\*?|class) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])));
      sharedModules.add(path.relative(process.cwd(), target).split(path.sep).join('/'));
    } catch {
      return null;
    }
  }
  return exportsOf.get(target);
}
const sharedModules = new Set();
for (const file of dashboard) {
  const text = await readFile(file, 'utf8');
  for (const m of text.matchAll(/^import \{([^}]+)\} from '([^']+)';/gm)) {
    const target = path.resolve(path.dirname(file), m[2]);
    const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    if (!(await exportsFor(target))) { failed++; console.error(`${file}: imports missing module ${m[2]}`); continue; }
    for (const n of names) {
      if (!exportsOf.get(target).has(n)) { failed++; console.error(`${file}: ${m[2]} does not export ${n}`); }
    }
  }
}

/* Offline shell: every file the page loads from this site must be cached by the service worker. */
const sw = await readFile('sw.js', 'utf8');
const shellList = sw.match(/const SHELL_FILES = \[([\s\S]*?)\];/);
const shell = new Set(shellList ? [...shellList[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []);
const vendor = (await readdir('src/vendor')).filter((f) => /\.(js|json)$/.test(f)).map((f) => `src/vendor/${f}`);
for (const file of [...dashboard.map((f) => f.split(path.sep).join('/')), ...vendor, ...sharedModules, 'poller/data/india-places.json']) {
  if (!shell.has(file)) { failed++; console.error(`sw.js: SHELL_FILES is missing ${file}`); }
}

try {
  JSON.parse(await readFile('config/monitor.json', 'utf8'));
} catch (err) {
  failed++;
  console.error(`config/monitor.json: ${err.message}`);
}
if (failed) {
  process.exitCode = 1;
} else {
  console.log('syntax and config checks passed');
}
