#!/usr/bin/env node
/**
 * Fetches every upstream source once from the GitHub runner and prints the HTTP status,
 * the headers that matter (content type, caching, CORS) and the start of the body, so a
 * format or endpoint change can be diagnosed without Actions logs (the workflow pushes
 * this output to the "diagnostics" branch). Read-only: writes nothing, sends nothing.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { newsQueryUrls } from './lib/news-core.mjs';
import { FIRE_FILES } from './sources/fires.mjs';
import { RESERVOIR_URL } from './sources/reservoirs.mjs';

const { values } = parseArgs({ options: { config: { type: 'string', default: 'config/monitor.json' }, bytes: { type: 'string', default: '1500' } } });
const config = process.env.MONITOR_CONFIG_JSON ? JSON.parse(process.env.MONITOR_CONFIG_JSON) : JSON.parse(await readFile(values.config, 'utf8'));
const limit = Number(values.bytes);
const userAgent = config.userAgent || 'OSI-Monitor/1.0';
const point = config.flood?.points?.[0] || { lat: 10.8, lng: 78.3 };
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

const SOURCES = [
  ...(config.sachet?.feeds || []).map((url) => ['SACHET RSS', url]),
  ['Open-Meteo forecast', `https://api.open-meteo.com/v1/forecast?latitude=${point.lat}&longitude=${point.lng}&daily=precipitation_sum,temperature_2m_max&forecast_days=3&timezone=Asia%2FKolkata`],
  ['Open-Meteo flood', `https://flood-api.open-meteo.com/v1/flood?latitude=${point.lat}&longitude=${point.lng}&daily=river_discharge&past_days=7&forecast_days=7`],
  ['Open-Meteo marine', 'https://marine-api.open-meteo.com/v1/marine?latitude=13.08&longitude=80.35&daily=wave_height_max&forecast_days=3'],
  ['GDACS events', 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ;TC;FL;VO;DR;WF&alertlevel=Orange;Red&pageSize=100'],
  ['GDACS cyclones', `https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC&fromdate=${day(-10)}&todate=${day(0)}&alertlevel=Green;Orange;Red&pageSize=50`],
  ['USGS earthquakes', 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson'],
  ['TN reservoirs', RESERVOIR_URL],
  ['OpenSky states', 'https://opensky-network.org/api/states/all?lamin=5&lomin=65&lamax=37&lomax=98'],
  ['adsb.lol regional', 'https://api.adsb.lol/v2/point/10.8/78.3/250'],
  ['CelesTrak visual', 'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle'],
  ...FIRE_FILES.map(([sat, url]) => [`FIRMS ${sat}`, url]),
  ['GDELT headlines', newsQueryUrls(6)[0]],
  ['RainViewer frames', 'https://api.rainviewer.com/public/weather-maps.json'],
  ['NASA GIBS capabilities', 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml']
];

for (const [label, url] of SOURCES) {
  console.log(`\n===== ${label}\nGET ${url}`);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': userAgent, Origin: 'https://example.org' }, signal: AbortSignal.timeout(30000) });
    const h = (k) => res.headers.get(k) || '-';
    const text = await res.text();
    console.log(`HTTP ${res.status} | ${h('content-type')} | ${text.length} chars | last-modified ${h('last-modified')} | etag ${h('etag')} | cors ${h('access-control-allow-origin')}`);
    console.log(text.slice(0, limit));
  } catch (err) {
    console.log(`ERROR ${err.name}: ${err.message}${err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : ''}`);
  }
}
