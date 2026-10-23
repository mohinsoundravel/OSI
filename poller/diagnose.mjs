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

/** Status line only (for images and large documents). */
async function probe(label, url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': ua, Origin: 'https://example.org' }, signal: AbortSignal.timeout(30000) });
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`PROBE ${label}: HTTP ${res.status} | ${res.headers.get('content-type')} | ${buf.length} bytes | acao: ${res.headers.get('access-control-allow-origin')}`);
    return { res, buf };
  } catch (err) {
    console.log(`PROBE ${label}: ERROR ${err.name}: ${err.message}`);
    return null;
  }
}

/* Weather overlays for the dashboard: RainViewer radar and NASA GIBS imagery. */
{
  const rv = await probe('RainViewer weather-maps.json', 'https://api.rainviewer.com/public/weather-maps.json');
  if (rv && rv.res.ok) {
    const j = JSON.parse(rv.buf.toString('utf8'));
    console.log(`RainViewer host=${j.host} generated=${j.generated} keys=${Object.keys(j).join(',')} radarKeys=${Object.keys(j.radar || {}).join(',')} frames=${(j.radar?.past || []).length}`);
    const last = (j.radar?.past || []).slice(-1)[0];
    if (last) {
      console.log(`RainViewer last frame time=${last.time} path=${last.path}`);
      await probe('RainViewer tile z4 India 256', `${j.host}${last.path}/256/4/11/7/2/1_1.png`);
      await probe('RainViewer tile z7 Chennai 256', `${j.host}${last.path}/256/7/92/60/2/1_1.png`);
      await probe('RainViewer tile z8 (expect refusal)', `${j.host}${last.path}/256/8/185/121/2/1_1.png`);
    }
  }
  const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await probe(`GIBS VIIRS SNPP true colour ${day} z0`, `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${day}/GoogleMapsCompatible_Level9/0/0/0.jpg`);
  await probe(`GIBS VIIRS SNPP true colour ${day} z9`, `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${day}/GoogleMapsCompatible_Level9/9/240/367.jpg`);
  const caps = await probe('GIBS capabilities', 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml');
  if (caps && caps.res.ok) {
    const xml = caps.buf.toString('utf8');
    const want = /IMERG|VIIRS_SNPP_CorrectedReflectance_TrueColor|VIIRS_NOAA20_CorrectedReflectance_TrueColor|Himawari|Band13|Clean_Infrared/i;
    for (const layer of xml.split('<Layer>').slice(1)) {
      const id = /<ows:Identifier>([^<]+)</.exec(layer)?.[1];
      if (!id || !want.test(id)) continue;
      const pick = (re) => (re.exec(layer)?.[1] || '').trim();
      console.log(`LAYER ${id} | format ${pick(/<Format>([^<]+)</)} | matrix ${pick(/<TileMatrixSet>([^<]+)</)} | time default ${pick(/<Default>([^<]+)</)} | time values ${pick(/<Value>([^<]+)</).slice(0, 120)} | url ${pick(/template="([^"]+)"/)}`);
    }
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
