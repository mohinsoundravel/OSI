#!/usr/bin/env node
/**
 * Prints raw samples from every configured source so format changes can be
 * diagnosed from the GitHub Actions log (the runner can reach sources that a
 * developer machine or sandbox may not). Read-only: writes nothing, sends nothing.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { parseRss } from './sources/sachet.mjs';

const { values } = parseArgs({ options: { config: { type: 'string', default: 'config/monitor.json' }, bytes: { type: 'string', default: '4000' } } });
const config = process.env.MONITOR_CONFIG_JSON ? JSON.parse(process.env.MONITOR_CONFIG_JSON) : JSON.parse(await readFile(values.config, 'utf8'));
const limit = Number(values.bytes);
const ua = config.userAgent || 'OSI-Monitor/1.0';

async function sample(label, url) {
  console.log(`\n===== ${label}\nGET ${url}`);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': ua, Origin: 'https://example.org' }, signal: AbortSignal.timeout(20000) });
    const h = (k) => res.headers.get(k);
    console.log(`HTTP ${res.status} | content-type: ${h('content-type')} | etag: ${h('etag')} | last-modified: ${h('last-modified')} | access-control-allow-origin: ${h('access-control-allow-origin')}`);
    const text = await res.text();
    console.log(`length ${text.length}\n----- body (first ${limit} chars) -----\n${text.slice(0, limit)}\n----- end -----`);
    return text;
  } catch (err) {
    console.log(`ERROR ${err.name}: ${err.message}${err.cause ? ` | cause: ${err.cause.code || ''} ${err.cause.message || err.cause}` : ''}`);
    return null;
  }
}

/* Satellite TLE sources (CelesTrak refused GitHub runners with a network error). */
await sample('CelesTrak .org', 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle');
await sample('CelesTrak .com', 'https://celestrak.com/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle');
await sample('AMSAT nasabare', 'https://www.amsat.org/tle/current/nasabare.txt');
await sample('SatNOGS TLE API (ISS)', 'https://db.satnogs.org/api/tle/?format=json&norad_cat_id=25544');
await sample('TLE API (ISS)', 'https://tle.ivanstanojevic.me/api/tle/25544');

for (const feed of config.sachet?.feeds || []) {
  const rss = await sample('SACHET RSS', feed);
  if (!rss) continue;
  const items = parseRss(rss);
  console.log(`parsed ${items.length} RSS items`);
  for (const item of items) console.log(`  item: ${item.title.slice(0, 140)} | ${item.link}`);
  const cap = await sample(`SACHET CAP: ${items[0]?.title}`, items[0]?.link);
  const polygonUrl = cap && /Polygon URL<\/(?:cap:)?valueName>\s*<(?:cap:)?value>([^<]+)</.exec(cap)?.[1];
  if (polygonUrl) await sample('SACHET polygon document', polygonUrl.trim());
  const tn = items.find((i) => /tamil|chennai|madurai|coimbatore|TN-|RMC Chennai/i.test(i.title));
  if (tn) await sample(`SACHET CAP (Tamil Nadu candidate): ${tn.title}`, tn.link);
}

await sample('OpenSky (India bounding box)', 'https://opensky-network.org/api/states/all?lamin=5&lomin=65&lamax=37&lomax=98');
const world = await sample('OpenSky (global)', 'https://opensky-network.org/api/states/all');
if (world) {
  try {
    console.log(`OpenSky global states: ${JSON.parse(world).states?.length ?? 'n/a'}, bytes: ${world.length}`);
  } catch { console.log('OpenSky global: not JSON'); }
}
await sample('GDACS SEARCH', 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ;TC;FL;VO;DR;WF&pageSize=100');

const p = config.flood?.points?.[0];
if (p) await sample('Open-Meteo flood (first point)', `https://flood-api.open-meteo.com/v1/flood?latitude=${p.lat}&longitude=${p.lng}&daily=river_discharge&past_days=7&forecast_days=7`);
