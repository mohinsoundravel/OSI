/** Layer definitions (labels, colours, detail fields), embedded players and poller-data normalisation. */
import {
  GDACS_TYPES, SEVERITY, SEV_COLOR, destination, fmtTime, getJson, hexToRgb, num, pos, relTime, store
} from './core.js';
import { AIS_STATUS, shipTypeLabel } from './snapshots.js';
import { SAT_CATS } from './satellites.js';
import { describeCyclone, describeFire, describeNews, describeSea } from './hazards.js';

/* ----- Embedded players: only URLs built here from validated IDs are ever framed. ----- */
const YT_CHANNEL_RE = /^UC[A-Za-z0-9_-]{22}$/;
export const EMBED_SRC_RE = /^https:\/\/(www\.youtube-nocookie\.com\/embed\/live_stream\?channel=UC[A-Za-z0-9_-]{22}&[a-z0-9=&_]+|webcams\.windy\.com\/webcams\/public\/embed\/player\/\d{5,14}\/(live|day))$/;

function youtubeLiveEmbed(channelId, label = 'Play live stream') {
  if (!YT_CHANNEL_RE.test(channelId)) return null;
  return {
    src: `https://www.youtube-nocookie.com/embed/live_stream?channel=${channelId}&autoplay=1&mute=1&playsinline=1&rel=0`,
    open: `https://www.youtube.com/channel/${channelId}/live`,
    label, note: 'YouTube, privacy-enhanced mode. Starts muted; shows an offline card when the channel is not live.'
  };
}

export function windyPlayerEmbed(webcamId, live) {
  const id = String(webcamId);
  if (!/^\d{5,14}$/.test(id)) return null;
  const src = `https://webcams.windy.com/webcams/public/embed/player/${id}/${live ? 'live' : 'day'}`;
  return { src, open: src, label: live ? 'Play live stream' : 'Play daylight timelapse', note: 'Windy webcam player (owner-published camera).' };
}

/* Official broadcaster channels, verified by channel ID (2026-10-24). Pins sit at the
   channels' home city; the stream itself shows whatever they are broadcasting. */
const LIVE_STREAMS = [
  { id: 'yt-thanthi', title: 'Thanthi TV (live)', channel: 'Thanthi TV', channelId: 'UC-JFyL0zDFOsPMpuWu39rPA', type: 'Tamil news', where: 'Chennai', lat: 13.045, lng: 80.25 },
  { id: 'yt-puthiyathalaimurai', title: 'Puthiya Thalaimurai (live)', channel: 'Puthiya Thalaimurai TV', channelId: 'UCmyKnNRH0wH-r8I-ceP-dsg', type: 'Tamil news', where: 'Chennai', lat: 13.01, lng: 80.215 },
  { id: 'yt-polimer', title: 'Polimer News (live)', channel: 'Polimer News', channelId: 'UC8Z-VjXBtDJTvq6aqkIskPg', type: 'Tamil news', where: 'Chennai', lat: 13.075, lng: 80.235 }
];
const NASA_CHANNEL_ID = 'UCLA_DiR1FfKNvjuUpBHmylQ';
export const liveStreamItems = () => LIVE_STREAMS.map((x) => ({ ...x, altKm: 0, embed: youtubeLiveEmbed(x.channelId), pageUrl: `https://www.youtube.com/channel/${x.channelId}/live` }));

export const LAYERS = {
  flights: {
    label: 'Flights', source: 'OpenSky Network', color: '#7fd8c0', size: 3.2, intervalMs: 20000, visible: true,
    describe: (it) => ({
      title: it.callsign,
      fields: [
        ['ICAO24', it.id], ['Origin', it.country], ['Squawk', it.squawk || 'n/a'],
        ['Status', it.onGround ? 'on ground' : 'airborne'], ['Baro altitude', num(it.baroAltM, 0, ' m')],
        ['Ground speed', it.velocity == null ? 'n/a' : num(it.velocity * 3.6, 0, ' km/h')],
        ['Track', num(it.track, 0, ' deg')], ['Vertical rate', num(it.verticalRate, 1, ' m/s')], ['Position', pos(it)],
        ...(Number.isFinite(it.reportedAt) ? [['Reported', `${relTime(it.reportedAt)}${it.projected ? ', position projected along track' : ''}`]] : [])
      ]
    })
  },
  quakes: {
    label: 'Earthquakes', source: 'USGS (24h)', color: '#e2554a', size: 5.5, intervalMs: 120000, visible: true,
    describe: (it) => ({
      title: `M${num(it.mag, 1)} ${it.place}`,
      fields: [
        ['Magnitude', num(it.mag, 1)], ['Depth', num(it.depthKm, 1, ' km')], ['Origin time', fmtTime(it.time)],
        ['Tsunami flag', it.tsunami ? 'YES' : 'no'], ['Position', pos(it)]
      ],
      url: it.url
    })
  },
  ships: {
    label: 'Ships (AIS)', source: 'AISStream via poller', color: '#5ac8fa', size: 4, intervalMs: 5 * 60 * 1000, visible: true,
    describe: (it) => ({
      title: it.name || `MMSI ${it.id}`,
      fields: [
        ['Type', shipTypeLabel(it.type)], ['MMSI', it.id], ['Call sign', it.callsign || 'n/a'],
        ['Speed', Number.isFinite(it.sog) ? `${it.sog.toFixed(1)} kn` : 'n/a'], ['Course', num(it.cog, 0, ' deg')],
        ['Status', AIS_STATUS[it.status] || 'n/a'], ['Destination', it.destination || 'n/a'],
        ['Length', Number.isFinite(it.lengthM) ? `${it.lengthM} m` : 'n/a'],
        ['Last AIS report', it.reportedAt ? `${relTime(it.reportedAt)}${it.projected ? ' (position estimated since)' : ''}` : 'n/a'],
        ['Position', pos(it)]
      ],
      url: `https://www.marinetraffic.com/en/ais/details/ships/mmsi:${encodeURIComponent(it.id)}`
    })
  },
  gdacs: {
    label: 'Disaster alerts', source: 'GDACS', color: '#f5a623', size: 7, intervalMs: 300000, visible: true,
    describe: (it) => ({
      title: it.name,
      fields: [
        ['Type', GDACS_TYPES[it.type] || it.type], ['Alert level', it.alertLevel], ['Country', it.country || 'n/a'],
        ['Severity', it.severity || 'n/a'], ['Since', it.from ? fmtTime(it.from) : 'n/a'], ['Position', pos(it)]
      ],
      url: it.url
    })
  },
  eonet: {
    label: 'Natural events', source: 'NASA EONET', color: '#f0997b', size: 5, intervalMs: 300000, visible: true,
    describe: (it) => ({
      title: it.title,
      fields: [['Category', it.category], ['Last update', it.date ? fmtTime(it.date) : 'n/a'], ['Position', pos(it)]],
      url: it.url
    })
  },
  satellites: {
    label: 'Satellites', source: 'CelesTrak, all active + SGP4', color: '#8aa9f7', size: 3.8, intervalMs: 6 * 3600 * 1000, visible: true,
    describe: (it) => ({
      title: it.name,
      fields: [
        ['NORAD ID', it.id], ['Type', it.cat && SAT_CATS[it.cat] ? SAT_CATS[it.cat].label : it.group], ['Altitude', num(it.altKm, 0, ' km')],
        ['Speed', num(it.speedKms, 2, ' km/s')], ['Elevation from observer', num(it.elevDeg, 1, ' deg')], ['Sub-point', pos(it)]
      ],
      embed: /ISS|ZARYA/i.test(it.name || '') ? youtubeLiveEmbed(NASA_CHANNEL_ID, 'Watch NASA live (ISS views when broadcasting)') : null
    })
  },
  webcams: {
    label: 'Public webcams', source: 'Windy Webcams API (zones)', color: '#c58af7', size: 4.5,
    intervalMs: 9 * 60 * 1000, visible: true,
    describe: (it) => ({
      title: it.title,
      image: it.imageUrl,
      imageLink: it.pageUrl,
      fields: [
        ['Webcam ID', it.id], ['Location', [it.city, it.region, it.country].filter(Boolean).join(', ') || 'n/a'],
        ['Status', it.status || 'n/a'], ['Image updated', it.lastUpdated ? fmtTime(it.lastUpdated) : 'n/a'],
        ['Zone', it.zone], ['Position', pos(it)]
      ],
      url: it.pageUrl,
      embed: it.embed || null
    })
  },
  live: {
    label: 'Live streams', source: 'Official YouTube channels', color: '#ff6b6b', size: 4.5,
    intervalMs: 24 * 3600 * 1000, visible: true,
    describe: (it) => ({
      title: it.title,
      embed: it.embed,
      fields: [['Channel', it.channel], ['Type', it.type], ['Based in', it.where], ['Position', pos(it)]],
      url: it.pageUrl
    })
  },
  alerts: {
    label: 'India alerts', source: 'SACHET + derived flood/heat + reservoirs (poller)', color: '#ff9f0a', size: 6.5,
    intervalMs: 5 * 60 * 1000, visible: true,
    describe: (it) => ({
      title: it.title,
      fields: [
        ['Type', it.isAlert ? (it.origin === 'official' ? 'Official warning' : 'Derived signal (not an official warning)') : 'Monitoring point'],
        ['Source', it.source || 'n/a'],
        ['Details', it.summary || 'n/a'],
        ...(it.instruction ? [['Advice', it.instruction]] : []),
        ...(it.districts && it.districts.length ? [['Districts', it.districts.join(', ')]] : []),
        ...(it.zones && it.zones.length ? [['Zones', it.zones.join(', ')]] : []),
        ...(it.expires ? [['Valid until', fmtTime(it.expires)]] : []),
        ['Position', pos(it)]
      ],
      url: it.sourceUrl
    })
  },
  cyclones: {
    label: 'Cyclones', source: 'GDACS tracks via poller', color: '#ffd60a', size: 6, intervalMs: 5 * 60 * 1000, visible: true,
    describe: (it) => describeCyclone(it)
  },
  sea: {
    label: 'Sea state', source: 'Open-Meteo Marine via poller', color: '#5ac8fa', size: 5, intervalMs: 15 * 60 * 1000, visible: true,
    describe: (it) => describeSea(it)
  },
  fires: {
    label: 'Fires', source: 'NASA FIRMS (VIIRS, 24 h) via poller', color: '#ff9f0a', size: 3, intervalMs: 15 * 60 * 1000, visible: true,
    describe: (it) => describeFire(it)
  },
  news: {
    label: 'News', source: 'GDELT headlines via poller (unverified)', color: '#9aa4b2', size: 4, intervalMs: 15 * 60 * 1000, visible: true,
    describe: (it) => describeNews(it)
  }
};

export const UNAVAILABLE_SOURCES = [];

/* Windy free tier: image URLs carry tokens that expire after ~10 min, so the layer refreshes every 9 min.
   Search radius per query is capped server-side; larger zones are clamped. */
export const WEBCAM_MAX_RADIUS_KM = 250;
export const WEBCAM_LIMIT_PER_ZONE = 50;

/* Poller output older than this is flagged as stale: a quiet feed must never look like "no alerts". */
export const BACKEND_STALE_MS = 90 * 60 * 1000;
const MAX_POLY_VERTICES = 400;

export const str = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : '');

function cleanRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const pts = ring.slice(0, MAX_POLY_VERTICES).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  return pts.length >= 4 ? pts : null;
}

const DISTRICT_RING_KM = 22;

/** A small circle around a district headquarters, as a [lng, lat] ring. */
function districtRing(lat, lng) {
  const ring = [];
  for (let b = 0; b <= 360; b += 20) {
    const p = destination(lat, lng, b, DISTRICT_RING_KM);
    ring.push([p.lng, p.lat]);
  }
  return ring;
}

function alertShapes(a) {
  const polys = (a.polygons || []).slice(0, 10).map(cleanRing).filter(Boolean);
  if (polys.length) return polys;
  return (Array.isArray(a.places) ? a.places : []).slice(0, 40)
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map((p) => districtRing(p.lat, p.lng));
}

/** Converts the poller's latest.json into layer items. The file is treated as untrusted input. */
export let lastBackend = null;
/* IMD 24-hour rain categories (mm): heavy 64.5, very heavy 115.6, extremely heavy 204.5. */
export const RAIN_CATS = [[204.5, '#ff453a', 'Extremely heavy (204.5+ mm/day)'], [115.6, '#ff9f0a', 'Very heavy (115.6+)'], [64.5, '#ffd60a', 'Heavy (64.5+)'], [0, '#64a8ff', 'Light to moderate']];
export const rainColor = (mm) => (RAIN_CATS.find(([min]) => (Number.isFinite(mm) ? mm : 0) >= min) || RAIN_CATS[3])[1];

export function normalizeBackend(latest) {
  if (!latest || typeof latest !== 'object' || !Array.isArray(latest.active)) throw new Error('unexpected latest.json format');
  lastBackend = latest;
  const polygonsById = new Map((latest.layers?.sachet || []).map((a) => [`sachet:${a.id}`, alertShapes(a)]));
  const placesById = new Map((latest.layers?.sachet || []).map((a) => [`sachet:${a.id}`,
    (Array.isArray(a.places) ? a.places : []).map((p) => str(p.name, 60)).filter(Boolean).slice(0, 40)]));
  const items = [];
  const alertedPoints = new Set();

  for (const a of latest.active) {
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lng)) continue;
    const severity = Object.hasOwn(SEVERITY, a.severity) ? a.severity : 'medium';
    const key = str(a.key, 200);
    if (!key) continue;
    const pointId = key.split(':').slice(0, 2).join(':');
    alertedPoints.add(pointId);
    items.push({
      id: key, alertKey: key, isAlert: true, origin: a.origin === 'official' ? 'official' : 'derived',
      kind: str(a.kind, 40), alertSeverity: severity, title: str(a.title, 300), summary: str(a.summary, 600),
      instruction: str(a.instruction, 600), source: str(a.source, 200), sourceUrl: str(a.sourceUrl, 500),
      zones: Array.isArray(a.zones) ? a.zones.map((z) => str(z, 60)).slice(0, 5) : [], expires: str(a.expires, 40) || null,
      lat: a.lat, lng: a.lng, altKm: 0, polygons: polygonsById.get(key) || [], color: hexToRgb(SEV_COLOR[severity]),
      districts: placesById.get(key) || []
    });
  }

  for (const r of latest.layers?.rivers || []) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng) || alertedPoints.has(`river:${r.id}`)) continue;
    items.push({
      id: `river:${str(r.id, 60)}`, isAlert: false, title: `River (model): ${str(r.name, 120)}`, source: 'GloFAS via Open-Meteo',
      summary: `7-day mean ${num(r.baseline, 0)} m3/s, forecast peak ${num(r.peak, 0)} m3/s on ${str(r.peakDate, 12) || 'n/a'}`,
      lat: r.lat, lng: r.lng, altKm: 0, polygons: [], color: hexToRgb('#3d8fb0')
    });
  }
  for (const h of latest.layers?.heat || []) {
    if (!Number.isFinite(h.lat) || !Number.isFinite(h.lng) || alertedPoints.has(`heat:${h.id}`)) continue;
    const days = Array.isArray(h.days) ? h.days : [];
    const peak = days.reduce((m, d) => (Number.isFinite(d.tmax) ? Math.max(m, d.tmax) : m), -Infinity);
    items.push({
      id: `heat:${str(h.id, 60)}`, isAlert: false, title: `Temperature (forecast): ${str(h.name, 120)}`, source: 'Open-Meteo forecast',
      summary: `Forecast max up to ${Number.isFinite(peak) ? peak.toFixed(1) : 'n/a'} C (${str(h.region, 20)} criteria)`,
      lat: h.lat, lng: h.lng, altKm: 0, polygons: [], color: hexToRgb('#8c6a3e')
    });
  }

  /* District rain forecast: shown where at least 10 mm is expected over three days. */
  for (const r of Array.isArray(latest.layers?.rain) ? latest.layers.rain : []) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng) || !(r.next72 >= 10) || alertedPoints.has(`rain:${r.id}`)) continue;
    items.push({
      id: `rain:${str(r.id, 60)}`, isAlert: false, title: `Rain forecast: ${str(r.name, 60)}`, source: 'Open-Meteo forecast (model)',
      summary: `3-day total ${num(r.next72, 0)} mm; wettest day ${num(r.peakMm, 0)} mm on ${str(r.peakDate, 12)}; last 24 h ${num(r.past24, 0)} mm`,
      lat: r.lat, lng: r.lng, altKm: 0, polygons: [], color: hexToRgb(rainColor(r.peakMm)), rainPeak: r.peakMm, rainTotal: r.next72
    });
  }

  const res = latest.layers?.reservoirs;
  const cusecs = (v) => (Number.isFinite(v) ? `${Math.round(v).toLocaleString('en-IN')} cusecs` : 'n/a');
  for (const r of (res && Array.isArray(res.items) ? res.items : [])) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng) || alertedPoints.has(`reservoir:${r.id}`)) continue;
    const change = Number.isFinite(r.levelChangeFt) && r.levelChangeFt !== 0 ? ` (${r.levelChangeFt > 0 ? '+' : ''}${num(r.levelChangeFt, 2)} ft in a day)` : '';
    items.push({
      id: `reservoir:${str(r.id, 60)}`, isAlert: false, title: `Reservoir: ${str(r.name, 120)}`,
      source: 'TN Agriculture Dept (WRD daily reservoir data)', sourceUrl: str(res.source, 300),
      summary: `${str(r.river, 40) ? `${str(r.river, 40)} \u00b7 ` : ''}level ${num(r.levelFt, 2)} of ${num(r.fullFt, 1)} ft (${num(r.pctDepth, 0)}% of depth)${change} \u00b7 inflow ${cusecs(r.inflow)} \u00b7 outflow ${cusecs(r.outflow)} \u00b7 as on ${str(res.date, 12)}`,
      lat: r.lat, lng: r.lng, altKm: 0, polygons: [], color: hexToRgb('#4fa3d9')
    });
  }

  const generatedMs = Date.parse(latest.generatedAt);
  if (!Number.isFinite(generatedMs)) items.warning = 'poller output has no timestamp';
  else if (Date.now() - generatedMs > BACKEND_STALE_MS) items.warning = `stale: poller last ran ${relTime(generatedMs)}`;
  const failing = Object.entries(latest.health || {}).filter(([, h]) => h && h.ok === false).map(([k]) => k);
  if (!items.warning && failing.length) items.warning = `poller sources failing: ${failing.join(', ')}`;
  return items;
}

/**
 * On GitHub Pages (owner.github.io/repo/), the poller's public data branch is
 * served by raw.githubusercontent.com, so the data URL can be derived with no setup.
 */
export function autoBackendUrl() {
  const host = location.hostname.toLowerCase();
  if (!host.endsWith('.github.io')) return '';
  const owner = host.slice(0, -'.github.io'.length);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return owner && repo ? `https://raw.githubusercontent.com/${owner}/${repo}/data` : '';
}

export const backendBase = () => store.get('backendUrl', '') || autoBackendUrl();

/* latest.json feeds several layers; one download serves them all for a minute. */
const LATEST_TTL_MS = 60 * 1000;
let latestAt = 0;
let latestPromise = null;
let latestCached = null;

export function getLatest() {
  if (latestCached && Date.now() - latestAt < LATEST_TTL_MS) return Promise.resolve(latestCached);
  if (!latestPromise) {
    latestPromise = (async () => {
      const base = backendBase();
      if (!base) throw new Error('no poller data URL set (Sources tab)');
      const url = new URL(`${base.replace(/\/+$/, '')}/latest.json`);
      url.searchParams.set('t', String(Math.floor(Date.now() / 60000)));
      const json = await getJson(url.href);
      latestCached = json;
      latestAt = Date.now();
      return json;
    })().finally(() => { latestPromise = null; });
  }
  return latestPromise;
}

export async function fetchBackendAlerts() {
  return normalizeBackend(await getLatest());
}
