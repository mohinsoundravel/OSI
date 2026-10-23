#!/usr/bin/env node
/**
 * Builds monthly climate normals of daily maximum temperature (1991-2020) for
 * each heat point, using the Open-Meteo historical archive (ERA5 reanalysis).
 * Incremental: points that already have normals are skipped, and the run stops
 * cleanly at Open-Meteo's rate limit (HTTP 429), saving progress. A 30-year
 * download counts as roughly 780 calls against the free daily limit of 10,000,
 * so a full set of stations completes over a couple of daily runs.
 * Output: <data-dir>/heat-normals.json
 *   { "<pointId>": [janC, febC, ..., decC], "_meta": {...} }
 *
 * Limitations: IMD normals are station-based and day-specific; these are
 * gridded monthly means. They are adequate for flagging departures but are one
 * more reason heat alerts are labelled "derived".
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createHttpClient } from './lib/http.mjs';

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string', default: 'data' },
    config: { type: 'string', default: 'config/monitor.json' },
    start: { type: 'string', default: '1991-01-01' },
    end: { type: 'string', default: '2020-12-31' }
  }
});

const config = process.env.MONITOR_CONFIG_JSON
  ? JSON.parse(process.env.MONITOR_CONFIG_JSON)
  : JSON.parse(await readFile(values.config, 'utf8'));
const points = config.heat?.points || [];
if (!points.length) {
  console.log('no heat points configured; nothing to do');
  process.exit(0);
}

const http = createHttpClient({ allowedHosts: ['archive-api.open-meteo.com'], userAgent: config.userAgent || 'OSI-Monitor/1.0', timeoutMs: 120000 });
await mkdir(values['data-dir'], { recursive: true });
const out = path.join(values['data-dir'], 'heat-normals.json');
const period = `${values.start}..${values.end}`;

let normals;
try {
  normals = JSON.parse(await readFile(out, 'utf8'));
} catch {
  normals = {};
}
if (normals._meta?.period !== period) normals = {};
normals._meta = { period, source: 'Open-Meteo archive (ERA5)', variable: 'temperature_2m_max monthly mean', updatedAt: new Date().toISOString() };

const save = async () => {
  await writeFile(`${out}.tmp`, `${JSON.stringify(normals, null, 1)}\n`);
  await rename(`${out}.tmp`, out);
};

const ids = new Set(points.map((p) => p.id));
for (const key of Object.keys(normals)) if (key !== '_meta' && !ids.has(key)) delete normals[key];
const missing = points.filter((p) => !Array.isArray(normals[p.id]));
console.log(`${points.length - missing.length}/${points.length} stations already have normals; ${missing.length} to build`);

/* One point per request, sequentially: gentler on the free API, and progress survives a rate limit. */
let built = 0;
for (const p of missing) {
  const q = new URLSearchParams({
    latitude: String(p.lat), longitude: String(p.lng),
    start_date: values.start, end_date: values.end,
    daily: 'temperature_2m_max', timezone: 'Asia/Kolkata'
  });
  let json;
  try {
    ({ json } = await http.getJson(`https://archive-api.open-meteo.com/v1/archive?${q}`));
  } catch (err) {
    if (err.status === 429) {
      console.log(`rate limit reached after ${built} station(s); remaining stations will be built on the next run`);
      break;
    }
    throw err;
  }
  const sums = new Array(12).fill(0);
  const counts = new Array(12).fill(0);
  json.daily.time.forEach((t, i) => {
    const v = json.daily.temperature_2m_max[i];
    if (!Number.isFinite(v)) return;
    const m = Number(t.slice(5, 7)) - 1;
    sums[m] += v;
    counts[m] += 1;
  });
  normals[p.id] = sums.map((s, m) => (counts[m] ? Math.round((s / counts[m]) * 10) / 10 : null));
  console.log(`${p.id}: ${normals[p.id].join(', ')}`);
  built++;
  await save();
}

await save();
const done = points.filter((p) => Array.isArray(normals[p.id])).length;
console.log(`normals available for ${done}/${points.length} stations`);
