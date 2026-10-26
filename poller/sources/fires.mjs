/**
 * Active fires from NASA FIRMS: the public 24-hour VIIRS files for South Asia (no key
 * needed), from three satellites. Detections are thermal hotspots at 375 m resolution;
 * a hotspot can be a forest fire, crop-residue burning, a flare or an industrial heat
 * source, so alerts are limited to configured forest areas and labelled derived.
 */

export const FIRES_MIN_INTERVAL_MS = 60 * 60 * 1000;
export const FIRE_FILES = [
  ['NOAA-20', 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_South_Asia_24h.csv'],
  ['NOAA-21', 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_South_Asia_24h.csv'],
  ['S-NPP', 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_South_Asia_24h.csv']
];
/* Published rows: [lat, lng, frp (MW), confidence (h/n), acquired (ISO), satellite]. */
export const FIRE_FIELDS = ['lat', 'lng', 'frpMw', 'confidence', 'acquiredAt', 'satellite'];
const MAX_ROWS = 8000;
const BOUNDS = { minLat: 0, maxLat: 40, minLng: 60, maxLng: 100 };

/** Parses a FIRMS VIIRS CSV; rows with low confidence or bad numbers are dropped. */
export function parseFirmsCsv(text, satellite) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const head = lines[0].split(',').map((h) => h.trim());
  const col = (name) => head.indexOf(name);
  const iLat = col('latitude');
  const iLng = col('longitude');
  const iFrp = col('frp');
  const iConf = col('confidence');
  const iDate = col('acq_date');
  const iTime = col('acq_time');
  if (iLat < 0 || iLng < 0 || iDate < 0) throw new Error('FIRMS: unexpected CSV header');
  const out = [];
  for (const line of lines.slice(1)) {
    const f = line.split(',');
    const lat = Number(f[iLat]);
    const lng = Number(f[iLng]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < BOUNDS.minLat || lat > BOUNDS.maxLat || lng < BOUNDS.minLng || lng > BOUNDS.maxLng) continue;
    const conf = String(f[iConf] || '').trim().toLowerCase();
    if (conf === 'low' || conf === 'l') continue;
    const date = String(f[iDate] || '').trim();
    const time = String(f[iTime] || '').trim().padStart(4, '0');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}$/.test(time)) continue;
    const frp = Number(f[iFrp]);
    out.push([
      Math.round(lat * 1e4) / 1e4, Math.round(lng * 1e4) / 1e4,
      Number.isFinite(frp) ? Math.round(frp * 10) / 10 : null,
      conf.startsWith('h') ? 'h' : 'n',
      `${date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`, satellite
    ]);
  }
  return out;
}

/** Merges satellites; the same spot seen twice (about 1 km grid) keeps the stronger detection. */
export function mergeFires(lists) {
  const byCell = new Map();
  for (const row of lists.flat()) {
    const cell = `${Math.round(row[0] * 100)}:${Math.round(row[1] * 100)}`;
    const prev = byCell.get(cell);
    if (!prev || (row[2] ?? 0) > (prev[2] ?? 0)) byCell.set(cell, row);
  }
  return [...byCell.values()].sort((a, b) => (b[2] ?? 0) - (a[2] ?? 0)).slice(0, MAX_ROWS);
}

export async function fetchFires({ http, lastFetchedAt = 0, now = Date.now(), minIntervalMs = FIRES_MIN_INTERVAL_MS }) {
  if (now - lastFetchedAt < minIntervalMs) return null;
  const results = await Promise.allSettled(FIRE_FILES.map(async ([sat, url]) => parseFirmsCsv((await http.getText(url, { timeoutMs: 45000 })).text, sat)));
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!ok.length) throw new Error(`FIRMS: ${results.map((r) => r.reason?.message).join('; ')}`);
  return {
    rows: mergeFires(ok),
    satellites: FIRE_FILES.filter((_, i) => results[i].status === 'fulfilled').map(([s]) => s)
  };
}

const toRad = (d) => (d * Math.PI) / 180;
function distanceKm(aLat, aLng, bLat, bLng) {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Detections inside each configured forest area; an alert when an area has enough of them. */
export function assessFires(rows, areas = [], { minDetections = 3 } = {}) {
  const out = [];
  for (const a of areas) {
    const inside = rows.filter((r) => distanceKm(a.lat, a.lng, r[0], r[1]) <= a.radiusKm);
    if (inside.length < minDetections) continue;
    const frp = inside.reduce((s, r) => s + (r[2] ?? 0), 0);
    out.push({
      area: a, count: inside.length, totalFrpMw: Math.round(frp),
      severity: inside.length >= minDetections * 3 ? 'high' : 'medium',
      latest: inside.map((r) => r[4]).sort().at(-1),
      lat: inside.reduce((s, r) => s + r[0], 0) / inside.length,
      lng: inside.reduce((s, r) => s + r[1], 0) / inside.length
    });
  }
  return out;
}
