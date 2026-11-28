/**
 * Poller-fed hazard layers: cyclone tracks (with forecast cone and wind swath on the globe),
 * coastal sea state, satellite fire hotspots and placed news headlines. Every file is
 * untrusted input: values are type-checked, strings capped, and only https links are used.
 */
import {
  GDACS_COLOR, RADIUS, destination, fmtTime, getJson, haversineKm, hexToRgb, num, pos
} from './core.js';
import { backendBase, getLatest, str } from './layers.js';
import { globeGroup, latLngToVector3, withLift } from './globe.js';
import { NEWS_REQUEST_GAP_MS, buildGazetteer, mergeNews, newsQueryUrls } from '../../poller/lib/news-core.mjs';

const IST_MS = 5.5 * 3600 * 1000;
const fin = (v) => (Number.isFinite(v) ? v : null);

/** "27 Oct 08:00 IST" for any parseable time. */
export function istText(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'n/a';
  const d = new Date(t + IST_MS);
  const mon = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `${d.getUTCDate()} ${mon} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} IST`;
}

/* ----- Cyclones ----- */

export const CYCLONE_CLASS = {
  TD: ['Tropical depression', '#64a8ff'],
  TS: ['Tropical storm', '#ffd60a'],
  HU: ['Cyclone (hurricane strength)', '#ff453a'],
  TY: ['Cyclone (typhoon strength)', '#ff453a']
};
const classLabel = (c) => (CYCLONE_CLASS[c] ? CYCLONE_CLASS[c][0] : c || 'n/a');
const classColor = (c) => (CYCLONE_CLASS[c] ? CYCLONE_CLASS[c][1] : '#ff9f0a');

function cleanRing(ring, max = 400) {
  if (!Array.isArray(ring)) return [];
  return ring.slice(0, max).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[1]) <= 90);
}

/** The watched coast (the poller's sea points) for closest-approach figures. */
function coastPoints(latest) {
  return (Array.isArray(latest?.layers?.sea) ? latest.layers.sea : []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

function closestApproach(track, places) {
  let best = null;
  for (let i = 0; i < track.length; i++) {
    const a = track[i];
    const b = track[i + 1] || a;
    for (let s = 0; s <= 10; s++) {
      const f = s / 10;
      const lat = a.lat + (b.lat - a.lat) * f;
      const lng = a.lng + (b.lng - a.lng) * f;
      for (const p of places) {
        const km = haversineKm(lat, lng, p.lat, p.lng);
        if (!best || km < best.km) best = { km, place: p.name, at: new Date(a.tMs + (b.tMs - a.tMs) * f).toISOString() };
      }
      if (b === a) break;
    }
  }
  return best;
}

/** latest.layers.cyclones -> storm items plus one small item per track point. */
export function cycloneItems(latest) {
  const storms = Array.isArray(latest?.layers?.cyclones) ? latest.layers.cyclones : [];
  const coast = coastPoints(latest);
  const items = [];
  for (const c of storms.slice(0, 8)) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
    const id = str(c.id, 40) || `TC-${str(c.eventId, 20)}`;
    const name = str(c.name, 60) || 'Cyclone';
    const level = ['Green', 'Orange', 'Red'].includes(c.alertLevel) ? c.alertLevel : 'Green';
    const track = (Array.isArray(c.track) ? c.track : []).slice(0, 60)
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(Date.parse(p.t)))
      .map((p) => ({ lat: p.lat, lng: p.lng, t: str(p.t, 40), tMs: Date.parse(p.t), cat: str(p.cat, 4), forecast: p.forecast === true }));
    const landfall = c.landfall && Number.isFinite(c.landfall.lat) && Number.isFinite(Date.parse(c.landfall.at))
      ? { near: str(c.landfall.near, 40), at: str(c.landfall.at, 40), lat: c.landfall.lat, lng: c.landfall.lng } : null;
    const near = track.length && coast.length ? closestApproach(track, coast) : null;
    items.push({
      id, stormId: id, kind: 'storm', name, alertLevel: level, lat: c.lat, lng: c.lng, altKm: 0,
      maxWindKmh: fin(c.maxWindKmh), severityText: str(c.severityText, 120), source: str(c.source, 20) || 'GDACS',
      updatedAt: str(c.updatedAt, 40), url: str(c.url, 300), landfall, nearCoast: near,
      track, cone: cleanRing(c.cone), swath: cleanRing(c.swaths?.kmh120), color: hexToRgb(GDACS_COLOR[level])
    });
    track.forEach((p, i) => {
      items.push({
        id: `${id}:${i}`, stormId: id, kind: 'track', name, lat: p.lat, lng: p.lng, altKm: 0,
        t: p.t, cat: p.cat, forecast: p.forecast, color: hexToRgb(classColor(p.cat))
      });
    });
  }
  return items;
}

export function describeCyclone(it) {
  if (it.kind === 'track') {
    return {
      title: `${it.name}: ${it.forecast ? 'forecast' : 'observed'} ${istText(it.t)}`,
      fields: [['Intensity', classLabel(it.cat)], ['Type', it.forecast ? 'Forecast position' : 'Observed position'], ['Position', pos(it)],
        ['Forecast by', 'JTWC via GDACS; IMD (RSMC New Delhi) issues the official warnings']]
    };
  }
  return {
    title: `Cyclone ${it.name}`,
    fields: [
      ['GDACS alert level', it.alertLevel], ['Maximum wind', it.maxWindKmh ? `${it.maxWindKmh} km/h` : 'n/a'],
      ['Intensity', it.severityText || 'n/a'], ['Position', pos(it)],
      ['Advisory', it.updatedAt ? istText(it.updatedAt) : 'n/a'],
      ['Landfall (estimate)', it.landfall
        ? `near ${it.landfall.near}, ${istText(it.landfall.at)}${Date.parse(it.landfall.at) < Date.now() ? ' (already crossed)' : ''}`
        : 'track does not cross the Indian coast'],
      ['Closest to Tamil Nadu coast', it.nearCoast ? `${num(it.nearCoast.km, 0)} km off ${it.nearCoast.place}, ${istText(it.nearCoast.at)}` : 'n/a'],
      ['Forecast by', `${it.source} via GDACS. Landfall is estimated where the track crosses a simplified coastline; follow IMD bulletins.`]
    ],
    url: it.url
  };
}

/* Track, cone and wind swath drawn on the globe; follows the layer's visibility. */
export const cycloneGroup = new THREE.Group();

function lineFrom(points, material, loop = false) {
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const line = loop ? new THREE.LineLoop(geo, material) : new THREE.Line(geo, material);
  if (material.isLineDashedMaterial) line.computeLineDistances();
  return line;
}

/** Densifies a lng/lat path so long segments follow the globe instead of cutting through it. */
function arcPoints(coords, radius) {
  const out = [];
  for (let i = 0; i < coords.length; i++) {
    const [lng, lat] = coords[i];
    out.push(latLngToVector3(lat, lng, radius));
    const next = coords[i + 1];
    if (!next) break;
    const steps = Math.min(12, Math.ceil(haversineKm(lat, lng, next[1], next[0]) / 60));
    for (let s = 1; s < steps; s++) {
      const f = s / steps;
      out.push(latLngToVector3(lat + (next[1] - lat) * f, lng + (next[0] - lng) * f, radius));
    }
  }
  return out;
}

export function updateCycloneOverlay(items) {
  for (const child of [...cycloneGroup.children]) {
    cycloneGroup.remove(child);
    child.geometry.dispose();
    child.material.dispose();
  }
  for (const s of items.filter((x) => x.kind === 'storm')) {
    const past = s.track.filter((p) => !p.forecast);
    const ahead = s.track.filter((p) => p.forecast);
    if (past.length) ahead.unshift(past[past.length - 1]);
    if (past.length >= 2) {
      cycloneGroup.add(lineFrom(arcPoints(past.map((p) => [p.lng, p.lat]), RADIUS + 0.6),
        withLift(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }))));
    }
    if (ahead.length >= 2) {
      cycloneGroup.add(lineFrom(arcPoints(ahead.map((p) => [p.lng, p.lat]), RADIUS + 0.6),
        withLift(new THREE.LineDashedMaterial({ color: 0xffd60a, dashSize: 0.9, gapSize: 0.6, transparent: true, opacity: 0.95, depthWrite: false }))));
    }
    if (s.cone.length >= 4) {
      cycloneGroup.add(lineFrom(arcPoints(s.cone, RADIUS + 0.5),
        withLift(new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.5, gapSize: 0.5, transparent: true, opacity: 0.55, depthWrite: false })), true));
    }
    if (s.swath.length >= 4) {
      cycloneGroup.add(lineFrom(arcPoints(s.swath, RADIUS + 0.5),
        withLift(new THREE.LineBasicMaterial({ color: 0xff453a, transparent: true, opacity: 0.6, depthWrite: false })), true));
    }
  }
}

/* ----- Sea state (Open-Meteo Marine at the poller's coastal points) ----- */

export const SEA_COLORS = [[6, '#ff453a', 'High (6 m+)'], [4, '#ff9f0a', 'Very rough (4-6 m)'], [2.5, '#ffd60a', 'Rough (2.5-4 m)'],
  [1.25, '#5ac8fa', 'Moderate (1.25-2.5 m)'], [0, '#64d2b4', 'Calm to slight']];
const seaColor = (m) => (SEA_COLORS.find(([min]) => (Number.isFinite(m) ? m : 0) >= min) || SEA_COLORS[4])[1];

export function seaItems(latest) {
  return (Array.isArray(latest?.layers?.sea) ? latest.layers.sea : []).slice(0, 40)
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map((p) => ({
      id: `sea:${str(p.id, 40)}`, name: str(p.name, 60), lat: p.lat, lng: p.lng, altKm: 0,
      nowM: fin(p.nowM), swellNowM: fin(p.swellNowM), periodS: fin(p.periodS), directionDeg: fin(p.directionDeg),
      peakM: fin(p.peakM), peakDate: str(p.peakDate, 12), state: str(p.state, 20),
      days: (Array.isArray(p.days) ? p.days : []).slice(0, 3).map((d) => ({ date: str(d.date, 12), maxM: fin(d.maxM) })),
      color: hexToRgb(seaColor(p.peakM))
    }));
}

export function describeSea(it) {
  return {
    title: `Sea state: ${it.name}`,
    fields: [
      ['Waves now', it.nowM === null ? 'n/a' : `${num(it.nowM, 1)} m${it.swellNowM !== null ? ` (swell ${num(it.swellNowM, 1)} m)` : ''}`],
      ['Period, direction', `${num(it.periodS, 1, ' s')}, from ${num(it.directionDeg, 0, ' deg')}`],
      ['Highest, next 48 h', it.peakM === null ? 'n/a' : `${num(it.peakM, 1)} m on ${it.peakDate} (${it.state.toLowerCase()})`],
      ['Daily maximum', it.days.map((d) => `${d.date.slice(5)} ${num(d.maxM, 1)} m`).join(', ') || 'n/a'],
      ['Position', pos(it)],
      ['Source', 'Open-Meteo Marine wave model; INCOIS issues the official high-wave alerts']
    ],
    url: 'https://incois.gov.in/portal/osf/osf.jsp'
  };
}

/* ----- Fires (NASA FIRMS, VIIRS, last 24 h) ----- */

export const FIRE_COLORS = [[20, '#ff453a', 'Intense (20+ MW)'], [5, '#ff9f0a', 'Moderate (5-20 MW)'], [0, '#ffd60a', 'Weak (below 5 MW)']];
const fireColor = (frp) => (FIRE_COLORS.find(([min]) => (Number.isFinite(frp) ? frp : 0) >= min) || FIRE_COLORS[2])[1];

export async function fetchFireItems() {
  const base = backendBase();
  if (!base) throw new Error('no poller data URL set (Sources tab)');
  const snap = await getJson(`${base.replace(/\/+$/, '')}/fires.json?t=${Math.floor(Date.now() / 600000)}`);
  const rows = Array.isArray(snap?.rows) ? snap.rows.slice(0, 10000) : [];
  const items = [];
  for (let i = 0; i < rows.length; i++) {
    const [lat, lng, frp, conf, at, sat] = Array.isArray(rows[i]) ? rows[i] : [];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    items.push({
      id: `fire:${i}:${lat},${lng}`, lat, lng, altKm: 0, frpMw: fin(frp), confidence: conf === 'h' ? 'high' : 'nominal',
      acquiredAt: str(at, 30), satellite: str(sat, 12), color: hexToRgb(fireColor(frp))
    });
  }
  const age = Date.now() - Date.parse(snap?.fetchedAt);
  if (Number.isFinite(age) && age > 6 * 3600 * 1000) items.warning = 'stale: fire data is more than 6 hours old';
  return items;
}

export function describeFire(it) {
  return {
    title: `Fire hotspot (${it.confidence} confidence)`,
    fields: [
      ['Radiative power', it.frpMw === null ? 'n/a' : `${num(it.frpMw, 1)} MW`], ['Detected', it.acquiredAt ? fmtTime(it.acquiredAt) : 'n/a'],
      ['Satellite', `${it.satellite} (VIIRS, 375 m)`], ['Position', pos(it)],
      ['Note', 'A thermal hotspot: a forest fire, crop-residue burning, a gas flare or an industrial heat source']
    ],
    url: `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${it.lng.toFixed(3)},${it.lat.toFixed(3)},11.0z`
  };
}

/* ----- News headlines (GDELT, placed by the poller) ----- */

export const NEWS_CATEGORY = {
  security: ['Security', '#ff453a'], unrest: ['Public order', '#ff9f0a'],
  accident: ['Accident or explosion', '#ffd60a'], hazard: ['Natural hazard', '#5ac8fa']
};

let gazetteerPromise = null;
const newsGazetteer = () => {
  gazetteerPromise ||= Promise.all([getJson('poller/data/districts.json'), getJson('poller/data/india-places.json')])
    .then(([districts, india]) => buildGazetteer(districts, india))
    .catch((err) => { gazetteerPromise = null; throw err; });
  return gazetteerPromise;
};

/**
 * Headlines: GDELT directly from this browser (it allows cross-origin reads, and a home
 * connection is not rate-limited the way GitHub's shared runners are), merged with the
 * poller's copy; the poller's copy alone if GDELT does not answer.
 */
export async function fetchNewsItems() {
  const base = backendBase();
  const pollerItems = base
    ? await getJson(`${base.replace(/\/+$/, '')}/news.json?t=${Math.floor(Date.now() / 600000)}`).then((s) => (Array.isArray(s?.items) ? s.items : [])).catch(() => [])
    : [];
  let raw = pollerItems;
  let direct = false;
  try {
    const gaz = await newsGazetteer();
    const articles = [];
    const urls = newsQueryUrls(12);
    for (let q = 0; q < urls.length; q++) {
      if (q) await new Promise((r) => setTimeout(r, NEWS_REQUEST_GAP_MS));
      try {
        const body = await getJson(urls[q]);
        if (Array.isArray(body?.articles)) {
          articles.push(...body.articles);
          direct = true;
        }
      } catch {
        /* Busy or rejected: the other queries and the poller's copy still count. */
      }
    }
    if (direct) raw = mergeNews(articles, gaz, pollerItems.filter((x) => x && typeof x.title === 'string'));
  } catch {
    /* Gazetteer unavailable: the poller's copy below. */
  }
  if (!base && !direct) throw new Error('GDELT unreachable and no poller data URL set');
  raw = raw.slice(0, 400);
  /* Headlines placed on the same town would sit on one pixel: fan them out a few km. */
  const perPlace = new Map();
  const items = raw.filter((n) => Number.isFinite(n.lat) && Number.isFinite(n.lng) && NEWS_CATEGORY[n.category]).map((n) => {
    const key = `${n.lat},${n.lng}`;
    const k = perPlace.get(key) || 0;
    perPlace.set(key, k + 1);
    const spot = k ? destination(n.lat, n.lng, (k * 137.5) % 360, 4 + 3 * Math.sqrt(k)) : { lat: n.lat, lng: n.lng };
    return {
      id: `news:${str(n.id, 20)}`, title: str(n.title, 240), url: str(n.url, 500), domain: str(n.domain, 80), at: str(n.at, 30),
      category: n.category, place: str(n.place, 60), state: str(n.state, 60), precision: str(n.precision, 12),
      sources: Number.isFinite(n.sources) ? n.sources : 1, lat: spot.lat, lng: spot.lng, altKm: 0,
      color: hexToRgb(NEWS_CATEGORY[n.category][1])
    };
  });
  return items;
}

export function describeNews(it) {
  return {
    title: it.title,
    fields: [
      ['Category', NEWS_CATEGORY[it.category][0]], ['Placed at', `${it.place}${it.precision === 'state' ? ' (state level)' : ''}, ${it.state}`],
      ['Source', it.domain], ['Seen', it.at ? fmtTime(it.at) : 'n/a'],
      ...(it.sources > 1 ? [['Similar headlines', `${it.sources} outlets`]] : []),
      ['Note', 'Machine-collected headline (GDELT); not verified. Location comes from the place named in the headline.']
    ],
    url: it.url,
    linkLabel: 'Open article'
  };
}

/* ----- Fetchers sharing the poller's latest.json ----- */

export async function fetchCycloneItems() {
  const items = cycloneItems(await getLatest());
  updateCycloneOverlay(items);
  return items;
}
export async function fetchSeaItems() {
  return seaItems(await getLatest());
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  globeGroup.add(cycloneGroup);
}
