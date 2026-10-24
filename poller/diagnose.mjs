#!/usr/bin/env node
/**
 * Prints raw samples from every configured source so format changes can be
 * diagnosed from the GitHub Actions log (the runner can reach sources that a
 * developer machine or sandbox may not). Read-only: writes nothing, sends nothing.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { parseRss } from './sources/sachet.mjs';
import { connectWebSocket } from './lib/ws.mjs';

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

/* AISStream handshake with a deliberately invalid key: proves the WebSocket client and
   network path work; a real key is used only by the poll step. */
{
  const msgs = [];
  let reason = null;
  try {
    const ws = await connectWebSocket('wss://stream.aisstream.io/v0/stream', { userAgent: ua, onMessage: (m) => msgs.push(m.slice(0, 200)), onClose: (r) => { reason = r; } });
    ws.send(JSON.stringify({ APIKey: 'invalid-diagnose-key', BoundingBoxes: [[[0, 60], [26, 100]]] }));
    await new Promise((r) => setTimeout(r, 6000));
    ws.close();
    console.log(`PROBE AISStream websocket: connected; messages ${JSON.stringify(msgs)}; close ${reason}`);
  } catch (err) {
    console.log(`PROBE AISStream websocket: ERROR ${err.message}`);
  }
}

/* Reservoir level page (status only; the parser runs in every poll). */
await probe('TN reservoir page', 'https://tnagriculture.in/people_app/more/reservoir/en/');

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
  const pngInfo = (r) => {
    if (!r || !r.buf || r.buf.length < 33 || r.buf.toString('ascii', 1, 4) !== 'PNG') return 'not png';
    const colorType = r.buf[25];
    const trns = r.buf.includes(Buffer.from('tRNS'));
    return `png ${r.buf.readUInt32BE(16)}x${r.buf.readUInt32BE(20)} colorType ${colorType}${trns ? ' +tRNS' : ''} sha ${createHash('sha1').update(r.buf).digest('hex').slice(0, 10)}`;
  };
  const floorTo = (ms, stepMin) => new Date(Math.floor(ms / (stepMin * 60000)) * stepMin * 60000).toISOString().replace('.000Z', 'Z');
  if (rv && rv.res.ok) {
    const j = JSON.parse(rv.buf.toString('utf8'));
    console.log(`RainViewer nowcast=${(j.radar?.nowcast || []).length} satellite=${JSON.stringify(j.satellite || {}).slice(0, 160)}`);
    const last = (j.radar?.past || []).slice(-1)[0];
    for (const [z, x, y] of [[4, 11, 7], [7, 92, 60], [8, 185, 121]]) console.log(`RainViewer z${z}: ${pngInfo(await probe(`rv z${z}`, `${j.host}${last.path}/256/${z}/${x}/${y}/2/1_1.png`))}`);
  }
  for (const lagMin of [40, 90]) {
    const t = floorTo(Date.now() - lagMin * 60000, 10);
    for (const [z, x, y] of [[5, 22, 15], [6, 45, 30], [6, 47, 29]]) {
      console.log(`Himawari IR ${t} z${z}/${x}/${y}: ${pngInfo(await probe('him', `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Himawari_AHI_Band13_Clean_Infrared/default/${t}/GoogleMapsCompatible_Level6/${z}/${y}/${x}.png`))}`);
    }
  }
  for (const lagMin of [330, 390]) {
    const t = floorTo(Date.now() - lagMin * 60000, 30);
    for (const [z, x, y] of [[2, 2, 1], [5, 22, 15]]) {
      console.log(`IMERG ${t} z${z}/${x}/${y}: ${pngInfo(await probe('imerg', `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/IMERG_Precipitation_Rate_30min/default/${t}/GoogleMapsCompatible_Level6/${z}/${y}/${x}.png`))}`);
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
