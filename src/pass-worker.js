'use strict';
/*
 * Visible satellite passes for one observer, off the main thread.
 *
 * A pass is visible to the naked eye when, at the same moment:
 *  - the satellite is at least MIN_ELEV degrees above the observer's horizon,
 *  - the observer is in darkness (Sun at least 6 degrees below the horizon), and
 *  - the satellite is in sunlight (outside the Earth's cylindrical shadow).
 * The page sends the bright-satellite TLEs and the observer; this worker searches the
 * next hours in 30 s steps, refines each edge to about 2 s, and returns the passes.
 * The observer's position never leaves the browser.
 */
importScripts('vendor/satellite.min.js');

const DEG = Math.PI / 180;
const RE = 6378.137;
const AU_KM = 149597870.7;
const STEP_S = 30;
const MIN_ELEV = 10;
const SUN_MAX_ALT = -6;
/* ISS standard magnitude (1,000 km range, half lit), the usual reference value. */
const STD_MAG = { 25544: -1.8 };

/** Low-precision solar position (about 0.01 deg), as an ECI unit vector. */
function sunEci(date) {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * DEG;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const e = (23.439 - 0.00000036 * d) * DEG;
  return { x: Math.cos(L), y: Math.cos(e) * Math.sin(L), z: Math.sin(e) * Math.sin(L) };
}

function look(obs, eci, gmst) {
  return satellite.ecfToLookAngles(obs, satellite.eciToEcf(eci, gmst));
}

/** True when the satellite (ECI km) is outside the Earth's shadow cylinder. */
function sunlit(r, s) {
  const dot = r.x * s.x + r.y * s.y + r.z * s.z;
  if (dot > 0) return true;
  const px = r.x - dot * s.x;
  const py = r.y - dot * s.y;
  const pz = r.z - dot * s.z;
  return Math.hypot(px, py, pz) > RE;
}

function stateAt(rec, obs, t) {
  const date = new Date(t);
  let pv;
  try { pv = satellite.propagate(rec, date); } catch { return null; }
  if (!pv || !pv.position || !Number.isFinite(pv.position.x)) return null;
  const gmst = satellite.gstime(date);
  const s = sunEci(date);
  const la = look(obs, pv.position, gmst);
  const sunLook = look(obs, { x: s.x * AU_KM, y: s.y * AU_KM, z: s.z * AU_KM }, gmst);
  const elev = la.elevation / DEG;
  const lit = sunlit(pv.position, s);
  const dark = sunLook.elevation / DEG <= SUN_MAX_ALT;
  /* Phase angle (Sun-satellite-observer) for a magnitude estimate. */
  const obsEcf = satellite.geodeticToEcf(obs);
  const satEcf = satellite.eciToEcf(pv.position, gmst);
  const toObs = { x: obsEcf.x - satEcf.x, y: obsEcf.y - satEcf.y, z: obsEcf.z - satEcf.z };
  const sunEcf = satellite.eciToEcf(s, gmst);
  const n = Math.hypot(toObs.x, toObs.y, toObs.z);
  const cosPhase = (toObs.x * sunEcf.x + toObs.y * sunEcf.y + toObs.z * sunEcf.z) / n;
  return {
    t, elev, az: la.azimuth / DEG, rangeKm: la.rangeSat, visible: elev >= MIN_ELEV && lit && dark,
    phase: Math.acos(Math.max(-1, Math.min(1, cosPhase)))
  };
}

/** Moves an edge between a non-visible and a visible sample to within ~2 s. */
function refine(rec, obs, tOut, tIn) {
  let a = tOut;
  let b = tIn;
  while (Math.abs(b - a) > 2000) {
    const m = (a + b) / 2;
    const st = stateAt(rec, obs, m);
    if (st && st.visible) b = m; else a = m;
  }
  return stateAt(rec, obs, b);
}

function magnitude(noradId, st) {
  const std = STD_MAG[noradId];
  if (!Number.isFinite(std) || !st) return null;
  /* Diffuse sphere phase law. */
  const p = st.phase;
  const f = (Math.sin(p) + (Math.PI - p) * Math.cos(p)) / Math.PI;
  if (f <= 0) return null;
  return Math.round((std - 15 + 5 * Math.log10(st.rangeKm) - 2.5 * Math.log10(f / 0.5)) * 10) / 10;
}

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type !== 'passes') return;
  const obs = { latitude: m.observer.lat * DEG, longitude: m.observer.lng * DEG, height: (m.observer.heightM || 0) / 1000 };
  const start = m.start;
  const end = start + (m.hours || 36) * 3600 * 1000;
  const passes = [];
  for (const sat of m.sats || []) {
    let rec;
    try { rec = satellite.twoline2satrec(sat.l1, sat.l2); } catch { continue; }
    let prev = null;
    let current = null;
    for (let t = start; t <= end; t += STEP_S * 1000) {
      const st = stateAt(rec, obs, t);
      if (!st) { prev = null; continue; }
      if (st.visible && !current) {
        const first = prev && !prev.visible ? refine(rec, obs, prev.t, t) : st;
        current = { start: first, max: st, last: st };
      } else if (st.visible && current) {
        if (st.elev > current.max.elev) current.max = st;
        current.last = st;
      } else if (!st.visible && current) {
        const last = refine(rec, obs, t, current.last.t) || current.last;
        passes.push(finish(sat, rec, obs, current, last));
        current = null;
      }
      prev = st;
    }
    if (current) passes.push(finish(sat, rec, obs, current, current.last));
  }
  passes.sort((a, b) => a.start - b.start);
  self.postMessage({ type: 'passes', requestId: m.requestId, observer: m.observer, computedAt: Date.now(), passes });
};

function finish(sat, rec, obs, p, last) {
  /* Refine the culmination on a 5 s grid around the best coarse sample. */
  let best = p.max;
  for (let t = p.max.t - 30000; t <= p.max.t + 30000; t += 5000) {
    const st = stateAt(rec, obs, t);
    if (st && st.visible && st.elev > best.elev) best = st;
  }
  return {
    id: sat.id, name: sat.name,
    start: p.start.t, end: last.t, durationS: Math.round((last.t - p.start.t) / 1000),
    startAz: Math.round(p.start.az), startEl: Math.round(p.start.elev),
    maxT: best.t, maxEl: Math.round(best.elev), maxAz: Math.round(best.az),
    endAz: Math.round(last.az), endEl: Math.round(last.elev),
    mag: magnitude(Number(sat.id), best)
  };
}
