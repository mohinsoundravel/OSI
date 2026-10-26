/**
 * Tropical cyclones in the North Indian Ocean: GDACS event list plus each storm's
 * geometry (track points, forecast segments with intensity class, uncertainty cone and
 * wind swaths). Forecasts come from the agency GDACS uses (usually JTWC), not IMD, and
 * are labelled as such.
 *
 * Landfall is estimated where the forecast track first crosses a simplified Indian
 * coastline, with time interpolated along the segment: indicative only.
 */

const LIST_URL = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';
const GEOMETRY_URL = 'https://www.gdacs.org/gdacsapi/api/polygons/getgeometry';
/* North Indian Ocean (Bay of Bengal and Arabian Sea) plus a margin. */
export const NIO = { minLat: -5, maxLat: 32, minLng: 45, maxLng: 100 };
const MAX_RING_VERTICES = 200;

/* Simplified Indian coastline, Sundarbans to Kutch (lng, lat), with names for landfall. */
export const COAST = [
  [88.9, 21.6, 'Sundarbans'], [87.5, 21.6, 'Digha'], [86.9, 21.1, 'Balasore'], [86.4, 20.25, 'Paradip'], [85.85, 19.8, 'Puri'],
  [84.9, 19.25, 'Gopalpur'], [83.9, 18.25, 'Srikakulam'], [83.3, 17.7, 'Visakhapatnam'], [82.3, 16.95, 'Kakinada'],
  [81.2, 16.15, 'Machilipatnam'], [80.4, 15.5, 'Ongole'], [80.15, 14.5, 'Nellore'], [80.25, 13.55, 'Pulicat'],
  [80.3, 13.08, 'Chennai'], [80.2, 12.6, 'Mamallapuram'], [79.85, 11.9, 'Puducherry'], [79.8, 11.5, 'Cuddalore'],
  [79.85, 10.77, 'Nagapattinam'], [79.85, 10.3, 'Point Calimere'], [79.3, 9.95, 'Pudukkottai coast'], [79.3, 9.3, 'Rameswaram'],
  [78.15, 8.8, 'Thoothukudi'], [77.55, 8.08, 'Kanyakumari'], [76.6, 8.9, 'Kollam'], [76.25, 9.95, 'Kochi'],
  [75.75, 11.25, 'Kozhikode'], [74.85, 12.85, 'Mangaluru'], [74.1, 14.8, 'Karwar'], [73.8, 15.5, 'Goa'],
  [73.3, 16.95, 'Ratnagiri'], [72.85, 18.95, 'Mumbai'], [72.65, 20.4, 'Daman'], [72.6, 21.6, 'Bharuch'],
  [70.95, 20.7, 'Diu'], [69.6, 21.65, 'Porbandar'], [69.0, 22.4, 'Dwarka'], [68.6, 23.5, 'Kutch']
];

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function simplifyRing(ring) {
  if (!Array.isArray(ring)) return [];
  const step = Math.max(1, Math.ceil(ring.length / MAX_RING_VERTICES));
  const out = ring.filter((_, i) => i % step === 0).map(([x, y]) => [round(x), round(y)]);
  if (ring.length) out.push([round(ring.at(-1)[0]), round(ring.at(-1)[1])]);
  return out;
}

const inNio = (lat, lng) => lat >= NIO.minLat && lat <= NIO.maxLat && lng >= NIO.minLng && lng <= NIO.maxLng;

/** "10260000" (MMDDhhmm) in the year of `ref` (handles a December to January rollover). */
function keyTime(key, ref) {
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const refDate = new Date(ref);
  let year = refDate.getUTCFullYear();
  if (Number(m[1]) === 1 && refDate.getUTCMonth() === 11) year += 1;
  const t = Date.UTC(year, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Centre of a small radius polygon (GDACS draws track points as circles). */
function ringCentre(ring) {
  const pts = ring.slice(0, -1);
  if (!pts.length) return null;
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}

/** Turns a GDACS TC geometry FeatureCollection into track, cone and swaths. */
export function parseCycloneGeometry(geo, { issuedAt }) {
  const feats = Array.isArray(geo?.features) ? geo.features : [];
  const points = [];
  const segments = [];
  let cone = null;
  const swaths = {};
  for (const f of feats) {
    const p = f.properties || {};
    const g = f.geometry || {};
    const cls = String(p.Class || '');
    if (cls.startsWith('Point_Polygon_Point') && g.type === 'Polygon') {
      const c = ringCentre(g.coordinates?.[0] || []);
      const t = keyTime(p.key, issuedAt);
      if (c && t) points.push({ t, lng: round(c[0]), lat: round(c[1]) });
    } else if (cls.startsWith('Line_Line') && g.type === 'LineString' && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
      segments.push({ from: g.coordinates[0], to: g.coordinates.at(-1), cat: String(p.polygonlabel || '').slice(0, 4), forecast: p.forecast === true || p.forecast === 'true' });
    } else if (cls === 'Poly_Cones' && g.type === 'Polygon') {
      cone = simplifyRing(g.coordinates?.[0]);
    } else if (/^Poly_(Green|Orange|Red)$/.test(cls) && !p.featuretype && g.type === 'Polygon') {
      swaths[{ Poly_Green: 'kmh60', Poly_Orange: 'kmh90', Poly_Red: 'kmh120' }[cls]] = simplifyRing(g.coordinates?.[0]);
    }
  }
  points.sort((a, b) => a.t.localeCompare(b.t));
  /* Intensity class: the segment that starts at (or nearest to) each point. */
  for (const pt of points) {
    let best = null;
    for (const s of segments) {
      const d = Math.hypot(s.from[0] - pt.lng, s.from[1] - pt.lat);
      if (d < 0.3 && (!best || d < best.d)) best = { d, s };
    }
    pt.cat = best ? best.s.cat : null;
    pt.forecast = Date.parse(pt.t) > Date.parse(issuedAt);
  }
  return { track: points, cone, swaths };
}

/* Segment intersection (x = lng, y = lat); returns the fraction along the first segment. */
function intersect(a1, a2, b1, b2) {
  const d = (a2[0] - a1[0]) * (b2[1] - b1[1]) - (a2[1] - a1[1]) * (b2[0] - b1[0]);
  if (Math.abs(d) < 1e-12) return null;
  const t = ((b1[0] - a1[0]) * (b2[1] - b1[1]) - (b1[1] - a1[1]) * (b2[0] - b1[0])) / d;
  const u = ((b1[0] - a1[0]) * (a2[1] - a1[1]) - (b1[1] - a1[1]) * (a2[0] - a1[0])) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
}

export function estimateLandfall(track) {
  for (let i = 0; i + 1 < track.length; i++) {
    const a = [track[i].lng, track[i].lat];
    const b = [track[i + 1].lng, track[i + 1].lat];
    for (let k = 0; k + 1 < COAST.length; k++) {
      const hit = intersect(a, b, COAST[k], COAST[k + 1]);
      if (!hit) continue;
      const lng = a[0] + (b[0] - a[0]) * hit.t;
      const lat = a[1] + (b[1] - a[1]) * hit.t;
      const t0 = Date.parse(track[i].t);
      const at = new Date(t0 + (Date.parse(track[i + 1].t) - t0) * hit.t).toISOString();
      const near = hit.u < 0.5 ? COAST[k][2] : COAST[k + 1][2];
      return { at, lat: round(lat), lng: round(lng), near, cat: track[i].cat };
    }
  }
  return null;
}

const toRad = (d) => (d * Math.PI) / 180;
export function distanceKm(aLat, aLng, bLat, bLng) {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Closest approach of the track (points and the segments between them) to a set of places. */
export function closestApproach(track, places) {
  let best = null;
  for (let i = 0; i < track.length; i++) {
    const a = track[i];
    const b = track[i + 1] || a;
    for (let s = 0; s <= 10; s++) {
      const f = s / 10;
      const lat = a.lat + (b.lat - a.lat) * f;
      const lng = a.lng + (b.lng - a.lng) * f;
      for (const p of places) {
        const km = distanceKm(lat, lng, p.lat, p.lng);
        if (!best || km < best.km) {
          const t0 = Date.parse(a.t);
          best = { km: Math.round(km), place: p.name, at: new Date(t0 + (Date.parse(b.t) - t0) * f).toISOString() };
        }
      }
      if (b === a) break;
    }
  }
  return best;
}

/**
 * Current North Indian Ocean cyclones with geometry. Geometry is fetched only when the
 * episode changes (GDACS issues a new episode with each advisory).
 */
export async function fetchCyclones({ http, cache = {}, now = Date.now(), log = () => {} }) {
  const from = new Date(now - 10 * 86400000).toISOString().slice(0, 10);
  const to = new Date(now + 86400000).toISOString().slice(0, 10);
  const { json } = await http.getJson(`${LIST_URL}?eventlist=TC&fromdate=${from}&todate=${to}&alertlevel=Green;Orange;Red&pageSize=50`, { timeoutMs: 45000 });
  const storms = (json?.features || []).filter((f) => {
    const [lng, lat] = f.geometry?.coordinates || [];
    return f.properties?.eventtype === 'TC' && String(f.properties?.iscurrent) === 'true' && inNio(Number(lat), Number(lng));
  });
  const nextCache = {};
  const out = [];
  for (const f of storms.slice(0, 6)) {
    const p = f.properties || {};
    const id = String(p.eventid);
    const episode = String(p.episodeid);
    let geom = cache[id]?.episode === episode ? cache[id].geom : null;
    if (!geom) {
      try {
        const { json: g } = await http.getJson(`${GEOMETRY_URL}?eventtype=TC&eventid=${encodeURIComponent(id)}&episodeid=${encodeURIComponent(episode)}`, { timeoutMs: 90000 });
        geom = parseCycloneGeometry(g, { issuedAt: p.todate ? `${p.todate}Z` : new Date(now).toISOString() });
      } catch (err) {
        log(`cyclones: geometry for ${id} unavailable (${err.message})`);
        geom = cache[id]?.geom || { track: [], cone: null, swaths: {} };
      }
    }
    nextCache[id] = { episode, geom };
    const [lng, lat] = f.geometry.coordinates;
    const wind = Number(p.severitydata?.severity);
    out.push({
      id: `TC-${id}`, eventId: id, episode, name: String(p.eventname || p.name || 'Cyclone').slice(0, 60),
      alertLevel: ['Green', 'Orange', 'Red'].includes(p.alertlevel) ? p.alertlevel : 'Green',
      lat: Number(lat), lng: Number(lng), maxWindKmh: Number.isFinite(wind) ? Math.round(wind) : null,
      severityText: String(p.severitydata?.severitytext || '').slice(0, 120),
      source: String(p.source || 'GDACS').slice(0, 20), updatedAt: p.datemodified ? `${p.datemodified}Z` : null,
      url: typeof p.url?.report === 'string' ? p.url.report : null,
      ...geom,
      landfall: estimateLandfall(geom.track)
    });
  }
  return { storms: out, cache: nextCache };
}
