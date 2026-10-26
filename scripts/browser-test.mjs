#!/usr/bin/env node
/**
 * Browser smoke test for the dashboard, with no dependencies.
 *
 * 1. Runs the poller against the recorded fixtures into a temporary data folder.
 * 2. Serves the site and that data folder on 127.0.0.1.
 * 3. Drives headless Chrome over the DevTools protocol with every non-local host blocked,
 *    so the result does not depend on any third-party service being up.
 * 4. Fails on any uncaught page error and on any broken core flow (boot, layers, search,
 *    detail panel, legend, mobile layout, demo mode).
 *
 * Usage: node scripts/browser-test.mjs [--chrome /path/to/chrome] [--shots dir] [--keep-open]
 * CHROME_PATH also selects the browser.
 */
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { connectWebSocket } from '../poller/lib/ws.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    chrome: { type: 'string' },
    shots: { type: 'string' },
    'keep-open': { type: 'boolean', default: false }
  }
});

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8'
};

/* ---------- Chrome discovery ---------- */

async function findChrome() {
  const explicit = args.chrome || process.env.CHROME_PATH;
  if (explicit) return explicit;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  /* Playwright's bundled Chromium, if present (development containers). */
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (existsSync(pw)) {
    for (const dir of (await readdir(pw)).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const p = path.join(pw, dir, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error('No Chrome or Chromium found; set CHROME_PATH.');
}

/* ---------- Static server for the site and the fixture data ---------- */

function startServer(dataDir) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let rel = decodeURIComponent(url.pathname);
      let base = ROOT;
      if (rel.startsWith('/__data/')) {
        base = dataDir;
        rel = rel.slice('/__data'.length);
      }
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(base, `.${rel}`);
      if (!file.startsWith(base + path.sep)) throw Object.assign(new Error('outside root'), { code: 'ENOENT' });
      const info = await stat(file);
      if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*'
      });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ---------- Minimal DevTools protocol client ---------- */

async function launchChrome(chromePath, profileDir) {
  const flags = [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-extensions', '--disable-sync', '--mute-audio', '--hide-scrollbars',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    /* Every host except the local server resolves to nothing: no external dependency. */
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
    '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--window-size=1440,900', 'about:blank'
  ];
  if (process.getuid && process.getuid() === 0) flags.unshift('--no-sandbox');
  const proc = spawn(chromePath, flags, { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${buf.slice(-500)}`)), 30000);
    proc.stderr.on('data', (chunk) => {
      buf += chunk;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited (${code}): ${buf.slice(-500)}`)); });
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  const conn = await connectWebSocket(wsUrl, {
    allowLoopback: true,
    maxBytes: 2 * 1024 * 1024 * 1024,
    onMessage: (text) => {
      const msg = JSON.parse(text);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data || ''}`.trim()));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of listeners) fn(msg);
      }
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    conn.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { proc, conn, send, listeners };
}

async function openPage(browser) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => browser.send(method, params, sessionId);
  const problems = [];
  const notes = [];
  browser.listeners.add((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      problems.push(`uncaught: ${d.exception?.description || d.text} (${d.url || ''}:${d.lineNumber})`);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      problems.push(`console.error: ${text}`);
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      const e = msg.params.entry;
      /* Blocked external hosts are expected; anything else (CSP, local 404s) is a problem. */
      /* Optional poller files (ships.json without an AIS key) are allowed to be missing. */
      if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_INTERNET_DISCONNECTED/.test(e.text)
        || (e.source === 'network' && !/127\.0\.0\.1/.test(e.url || ''))
        || (e.source === 'network' && /\/__data\/ships\.json$/.test(e.url || ''))) notes.push(e.text);
      else problems.push(`${e.source}: ${e.text} ${e.url || ''}`.trim());
    }
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };
  const waitFor = async (expression, timeoutMs = 20000, label = expression) => {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      try {
        last = await evaluate(expression);
        if (last) return last;
      } catch (err) {
        last = err.message;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`timed out waiting for: ${label} (last: ${JSON.stringify(last)})`);
  };
  const navigate = async (url) => {
    await send('Page.navigate', { url });
  };
  const shot = async (name) => {
    if (!args.shots) return;
    await mkdir(args.shots, { recursive: true });
    const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
    await writeFile(path.join(args.shots, `${name}.jpg`), Buffer.from(data, 'base64'));
  };
  return { send, evaluate, waitFor, navigate, shot, problems, notes };
}

/* ---------- The checks ---------- */

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log(`ok   ${name}${detail ? ` (${detail})` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: err.message });
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

const text = (sel) => `(document.querySelector(${JSON.stringify(sel)})?.textContent || '').replace(/\\s+/g, ' ').trim()`;
const click = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`;
const typeInto = (sel, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false;
  el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;

async function main() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'osi-browser-'));
  const dataDir = path.join(tmp, 'data');
  await mkdir(dataDir);
  const poll = spawnSync(process.execPath, [
    'poller/index.mjs', '--data-dir', dataDir, '--config', 'poller/test/monitor.test-config.json',
    '--fixtures', 'poller/test/fixtures', '--dry-run', '--now', '2026-10-23T06:00:00Z'
  ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', HEALTHCHECK_URL: '', AISSTREAM_API_KEY: '' } });
  if (poll.status !== 0) throw new Error(`fixture poll failed:\n${poll.stderr || poll.stdout}`);

  const server = await startServer(dataDir);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chromePath = await findChrome();
  const browser = await launchChrome(chromePath, path.join(tmp, 'profile'));
  console.log(`Chrome: ${chromePath}\nSite:   ${origin}\n`);
  let failed = false;
  try {
    const page = await openPage(browser);
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('gm.backendUrl', JSON.stringify('${origin}/__data')); } catch (e) {}`
    });

    await check('boots without errors', async () => {
      await page.navigate(`${origin}/index.html`);
      await page.waitFor(`document.body.classList.contains('booted')`, 20000, 'body.booted');
      const gl = await page.evaluate(`(() => { const c = document.getElementById('globe'); return c.width > 0 && c.height > 0; })()`);
      if (!gl) throw new Error('globe canvas has no size');
      return null;
    });

    await check('poller data reaches the layers', async () => {
      const sats = await page.waitFor(`(() => { const t = ${text('[data-src=satellites]')}; const m = t.match(/live\\s*([\\d,]+)/); return m && Number(m[1].replace(/,/g, '')) > 0 ? m[1] : null; })()`, 30000, 'satellites live');
      const india = await page.waitFor(`(() => { const t = ${text('[data-src=alerts]')}; const m = t.match(/(?:live|stale)\\s*([\\d,]+)/); return m && Number(m[1].replace(/,/g, '')) > 0 ? m[1] : null; })()`, 30000, 'India alerts loaded');
      return `satellites ${sats}, India alerts ${india}`;
    });

    await check('hazard layers load: cyclone, sea, fires, news', async () => {
      const counts = {};
      for (const key of ['cyclones', 'sea', 'fires', 'news']) {
        counts[key] = await page.waitFor(`(() => { const t = ${text(`[data-src=${key}]`)}; const m = t.match(/(?:live|stale)\\s*([\\d,]+)/); return m && Number(m[1].replace(/,/g, '')) > 0 ? m[1] : null; })()`, 30000, `${key} loaded`);
      }
      return Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ');
    });

    await check('cyclone detail shows the estimated landfall', async () => {
      await page.evaluate(typeInto('#search', 'MONTHA'));
      await page.waitFor(`[...document.querySelectorAll('#searchResults [data-hit]')].some((b) => /Cyclones/.test(b.textContent))`, 8000, 'cyclone in search results');
      await page.evaluate(`[...document.querySelectorAll('#searchResults [data-hit]')].find((b) => /Cyclones/.test(b.textContent)).click()`);
      const d = await page.waitFor(`(() => { const t = ${text('#detail')}; return /Landfall \\(estimate\\)near (Pulicat|Chennai)/.test(t) ? t.slice(0, 120) : null; })()`, 8000, 'landfall in the cyclone detail');
      await page.shot('cyclone');
      return d;
    });

    await check('search finds a district and opens its detail', async () => {
      await page.evaluate(typeInto('#search', 'Theni'));
      await page.waitFor(`document.querySelector('#searchResults [data-hit="0"]') && !document.getElementById('searchResults').hidden`, 8000, 'search results');
      await page.evaluate(click('#searchResults [data-hit="0"]'));
      const detail = await page.waitFor(`(() => { const t = ${text('#detail')}; return /Theni/i.test(t) ? t.slice(0, 80) : null; })()`, 8000, 'detail mentions Theni');
      return detail;
    });

    await check('satellite detail opens from search', async () => {
      await page.evaluate(typeInto('#search', 'ISS (ZARYA)'));
      await page.waitFor(`/ZARYA/.test(${text('#searchResults')})`, 8000, 'satellite in search results');
      const clicked = await page.evaluate(`(() => { const b = [...document.querySelectorAll('#searchResults [data-hit]')].find((x) => /Satellites/.test(x.textContent)); if (!b) return 'no button: ' + JSON.stringify(document.getElementById('searchResults').textContent.replace(/\\s+/g, ' ')) + ' | sats=' + document.querySelector('[data-src=satellites]').textContent.replace(/\\s+/g, ' '); try { b.click(); return 'clicked ' + b.dataset.hit; } catch (e) { return 'threw ' + e.stack; } })()`);
      if (!/^clicked/.test(clicked)) throw new Error(clicked);
      await page.waitFor(`/NORAD/.test(${text('#detail')})`, 8000, `NORAD ID in detail`).catch(async (err) => {
        throw new Error(`${err.message}; detail: ${await page.evaluate(text('#detail'))}`.slice(0, 400));
      });
      await page.shot('desktop-satellite');
      return null;
    });

    await check('legend opens', async () => {
      await page.evaluate(click('#legendBtn'));
      await page.waitFor(`!document.getElementById('legend').hidden && ${text('#legend')}.length > 10`, 5000, 'legend visible');
      await page.evaluate(click('#legendBtn'));
      return null;
    });

    await check('layer chip toggles a layer', async () => {
      const before = await page.evaluate(`document.querySelector('[data-chip=satellites]')?.getAttribute('aria-pressed')`);
      await page.evaluate(click('[data-chip=satellites]'));
      const after = await page.evaluate(`document.querySelector('[data-chip=satellites]')?.getAttribute('aria-pressed')`);
      await page.evaluate(click('[data-chip=satellites]'));
      if (before === after) throw new Error(`aria-pressed stayed ${before}`);
      return null;
    });

    await check('frames keep rendering', async () => {
      /* Software rendering in CI is slow; this only proves the render loop is alive. */
      const frames = await page.evaluate(`new Promise((res) => { let n = 0; const t0 = performance.now();
        const f = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); })`);
      if (!(frames >= 2)) throw new Error(`only ${frames} frames in 3 s`);
      return `${(frames / 3).toFixed(1)} fps (software rendering)`;
    });

    await check('mobile layout has no horizontal scroll', async () => {
      await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await page.navigate(`${origin}/index.html?mobile=1`);
      await page.waitFor(`location.search === '?mobile=1' && document.body.classList.contains('booted')`, 20000, 'mobile page booted');
      const overflow = await page.evaluate(`document.documentElement.scrollWidth - window.innerWidth`);
      if (overflow > 1) throw new Error(`page is ${overflow}px wider than the screen`);
      const toggles = await page.evaluate(`[...document.querySelectorAll('.mobile-toggle')].filter((b) => getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0).length`);
      if (toggles < 2) throw new Error('panel toggles hidden on mobile');
      await page.evaluate(click('#toggleLeft'));
      await page.waitFor(`document.getElementById('left').classList.contains('open')`, 4000, 'left panel opens');
      await page.shot('mobile-panel');
      await page.send('Emulation.clearDeviceMetricsOverride');
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      return null;
    });

    await check('demo mode loads synthetic events', async () => {
      await page.navigate(`${origin}/index.html?demo=1`);
      await page.waitFor(`location.search === '?demo=1' && document.body.classList.contains('booted')`, 20000, 'demo page booted');
      await page.waitFor(`!document.getElementById('demoPill').hidden`, 5000, 'DEMO pill');
      const n = await page.waitFor(`document.querySelectorAll('#feed .ev').length || null`, 30000, 'demo events in the feed');
      await page.shot('demo');
      return `${n} events`;
    });

    await check('offline cache installs every app file', async () => {
      /* The service worker registers on https or localhost only. */
      const local = origin.replace('127.0.0.1', 'localhost');
      await page.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try { localStorage.setItem('gm.backendUrl', JSON.stringify('${local}/__data')); } catch (e) {}`
      });
      await page.navigate(`${local}/index.html`);
      await page.waitFor(`location.hostname === 'localhost' && document.body.classList.contains('booted')`, 20000, 'localhost page booted');
      const result = await page.waitFor(`(async () => {
        const reg = await navigator.serviceWorker.ready;
        const keys = await caches.keys();
        const shell = keys.find((k) => k.endsWith('-shell'));
        if (!reg.active || !shell) return null;
        return { cache: shell, files: (await (await caches.open(shell)).keys()).length };
      })()`, 20000, 'service worker active with a shell cache');
      return `${result.files} files in ${result.cache}`;
    });

    if (page.problems.length) {
      results.push({ name: 'no page errors', ok: false, detail: page.problems.slice(0, 20).join('\n  ') });
      console.log(`FAIL no page errors:\n  ${page.problems.slice(0, 20).join('\n  ')}`);
    } else {
      console.log(`ok   no page errors (${page.notes.length} blocked external requests, as intended)`);
    }
    failed = results.some((r) => !r.ok);
  } finally {
    if (!args['keep-open']) {
      browser.conn.close();
      browser.proc.kill('SIGKILL');
      server.close();
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
}).finally(() => {
  /* Chrome or the server can keep the event loop alive after a failure. */
  if (!args['keep-open']) setTimeout(() => process.exit(), 500).unref();
});
