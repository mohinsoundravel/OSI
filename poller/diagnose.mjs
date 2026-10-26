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
import { createHttpClient } from './lib/http.mjs';
import { fetchNews, loadNewsGazetteer, categorize, placeHeadline } from './sources/news.mjs';

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

/* News pipeline end to end with the real API: raw counts, errors, and why headlines were dropped. */
{
  const http = createHttpClient({ allowedHosts: ['api.gdeltproject.org'], userAgent: ua });
  const raw = [];
  const wrapped = { getText: async (url, o) => { const r = await http.getText(url, o); raw.push(r.text); return r; } };
  try {
    const r = await fetchNews({ http: wrapped, now: Date.now(), retryWaitMs: 15000 });
    console.log(`NEWS fetched ${r.fetched}, placed ${r.items.length}, retries ${JSON.stringify(r.errors)}`);
    for (const i of r.items.slice(0, 15)) console.log(`  placed: ${i.category} | ${i.place} | ${i.title.slice(0, 100)}`);
  } catch (err) {
    console.log(`NEWS failed: ${err.message}`);
  }
  const gaz = loadNewsGazetteer();
  for (const text of raw) {
    console.log(`  raw response: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
    let arts = [];
    try { arts = JSON.parse(text).articles || []; } catch { continue; }
    for (const a of arts.slice(0, 40)) console.log(`    ${a.language} | cat=${categorize(a.title || '')} | place=${placeHeadline(a.title || '', gaz)?.name} | ${String(a.title).slice(0, 100)}`);
  }
}

/* ---- New sources: cyclone tracks, sea state, news events, fires ---- */
{
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const list = await sample('GDACS TC events (30 days)', `https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC&fromdate=${from}&todate=${today}&alertlevel=green;orange;red`);
  let tcs = [];
  try { tcs = JSON.parse(list).features || []; } catch { /* printed above */ }
  /* Indian Ocean systems first, then the most severe elsewhere. */
  const io = (f) => { const [x, y] = f.geometry?.coordinates || []; return x > 40 && x < 100 && y > -15 && y < 30; };
  const rank = { Red: 2, Orange: 1, Green: 0 };
  tcs.sort((a, b) => (io(b) - io(a)) || (rank[b.properties?.alertlevel] - rank[a.properties?.alertlevel]));
  for (const f of tcs.filter((x) => String(x.properties?.iscurrent) === 'true').slice(0, 2)) {
    const p = f.properties || {};
    console.log(`TC ${p.eventid}/${p.episodeid} ${p.name} ${p.alertlevel} at ${f.geometry?.coordinates} ${p.fromdate}..${p.todate} severity=${JSON.stringify(p.severitydata)}`);
    const geoUrl = `https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=TC&eventid=${p.eventid}&episodeid=${p.episodeid}`;
    let r = null;
    for (let attempt = 0; attempt < 2 && !(r && r.res.ok); attempt++) {
      try {
        const res = await fetch(geoUrl, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(90000) });
        r = { res, buf: Buffer.from(await res.arrayBuffer()) };
        console.log(`PROBE geometry ${p.eventid}: HTTP ${res.status} ${r.buf.length} bytes`);
      } catch (err) { console.log(`PROBE geometry ${p.eventid}: ${err.message}`); }
    }
    if (!r || !r.res.ok) continue;
    try {
      const g = JSON.parse(r.buf.toString('utf8'));
      const feats = g.features || [];
      const base = feats.find((x) => x.properties?.Class === 'Point_Centroid')?.properties || {};
      for (const x of feats) {
        const props = x.properties || {};
        const diff = Object.fromEntries(Object.entries(props).filter(([k, v]) => JSON.stringify(base[k]) !== JSON.stringify(v)));
        const geom = x.geometry || {};
        const coords = JSON.stringify(geom.coordinates || []);
        console.log(`  ${geom.type} ${props.Class} | ${JSON.stringify(diff).slice(0, 500)} | coords ${coords.length}b ${coords.slice(0, 120)}`);
      }
    } catch (err) {
      console.log(`  geometry not JSON: ${err.message}`);
    }
    await sample(`GDACS event data ${p.eventid}`, `https://www.gdacs.org/gdacsapi/api/events/geteventdata?eventtype=TC&eventid=${p.eventid}`);
  }
  await sample('Open-Meteo marine (Chennai, Rameswaram)', 'https://marine-api.open-meteo.com/v1/marine?latitude=13.08,9.28&longitude=80.35,79.35&daily=wave_height_max,swell_wave_height_max,wave_period_max&hourly=wave_height&forecast_days=3&timezone=Asia%2FKolkata');
  await sample('GDELT DOC (India unrest, 6 h, English)', 'https://api.gdeltproject.org/api/v2/doc/doc?query=(riot%20OR%20clash%20OR%20curfew%20OR%20explosion%20OR%20stampede)%20sourcecountry:IN%20sourcelang:english&mode=artlist&format=json&maxrecords=10&timespan=6h&sort=datedesc');
  await sample('FIRMS NOAA-21 VIIRS South Asia 24h', 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_South_Asia_24h.csv');
  for (const [label, url] of [
    ['FIRMS NOAA-20 VIIRS South Asia 24h', 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_South_Asia_24h.csv'],
    ['FIRMS S-NPP VIIRS South Asia 24h', 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_South_Asia_24h.csv'],
    ['FIRMS MODIS South Asia 24h', 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_South_Asia_24h.csv']
  ]) {
    const r = await probe(label, url);
    if (r && r.res.ok) {
      const lines = r.buf.toString('utf8').split('\n');
      console.log(`FIRMS ${label}: ${lines.length - 1} rows\n  ${lines.slice(0, 3).join('\n  ')}`);
    }
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
      if (!/^(IMERG_Precipitation_Rate_30min|Himawari_AHI_Band13_Clean_Infrared)$/.test(id)) continue;
      const def = pick(/<Default>([^<]+)</);
      for (const t of ['default', def]) {
        const r = await probe(`${id} time=${t}`, `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${id}/default/${t}/GoogleMapsCompatible_Level6/2/1/2.png`);
        if (r) console.log(`  ${id} time=${t}: sha ${createHash('sha1').update(r.buf).digest('hex').slice(0, 12)} | last-modified ${r.res.headers.get('last-modified')} | cache-control ${r.res.headers.get('cache-control')} | ${[...r.res.headers.entries()].filter(([k]) => /^layer-|expose/.test(k)).map(([k, v]) => `${k}=${v}`).join(' ; ')}`);
      }
      const hrefs = [...layer.matchAll(/xlink:href="([^"]*colormaps[^"]*\.xml)"/g)].map((m) => m[1]);
      console.log(`  colormap hrefs: ${hrefs.join(' ')}`);
      for (const href of hrefs.filter((h) => /v1\.3/.test(h)).slice(0, 1)) {
        const r = await probe(`colormap ${id}`, href);
        if (!r || !r.res.ok) continue;
        const cm = r.buf.toString('utf8');
        const entries = [...cm.matchAll(/<ColorMapEntry\b([^>]*)\/?>/g)].map((m) => {
          const at = (k) => (new RegExp(`${k}="([^"]*)"`).exec(m[1]) || [])[1] || '';
          return `${at('rgb')}|${at('transparent')}|${at('label') || at('value')}`;
        });
        console.log(`COLORMAP ${id} units=${(/units="([^"]*)"/.exec(cm) || [])[1] || ''} n=${entries.length}`);
        const step = Math.max(1, Math.floor(entries.length / 14));
        for (let i = 0; i < entries.length; i += step) console.log(`  ${i}: ${entries[i]}`);
        console.log(`  last: ${entries[entries.length - 1]}`);
      }
    }
  }
}

/* Full satellite catalogues: count three-line records per source. */
for (const [label, url] of [
  ['CelesTrak active', 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle'],
  ['CelesTrak active (.com)', 'https://celestrak.com/NORAD/elements/gp.php?GROUP=active&FORMAT=tle'],
  ['CelesTrak starlink', 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle'],
  ['SatNOGS all TLE', 'https://db.satnogs.org/api/tle/?format=json']
]) {
  const r = await probe(label, url);
  if (!r || !r.res.ok) continue;
  const text = r.buf.toString('utf8');
  const n = label.startsWith('SatNOGS') ? (() => { try { return JSON.parse(text).length; } catch { return 'not json'; } })() : (text.match(/^1 \d{5}/gm) || []).length;
  console.log(`CATALOG ${label}: ${n} records, ${r.buf.length} bytes, first: ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
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
