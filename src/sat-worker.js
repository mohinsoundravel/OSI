'use strict';
/*
 * Satellite keyframes off the main thread. The page sends the catalogue once, then asks
 * for a keyframe (all positions at one instant) every 10 seconds; it interpolates
 * between keyframes on every animation frame, so ~16,000 satellites glide without the
 * main thread running SGP4.
 *
 * satellite.js is served from this site (src/vendor), byte-identical to the pinned CDN
 * build (same SHA-384 as the page's integrity attribute), so the worker loads no
 * third-party code.
 */
importScripts('vendor/satellite.min.js');

const DEG = Math.PI / 180;
const RADIUS = 100;
let satrecs = [];

/* Same projection and log-scaled altitude as the page (latLngToVector3, displayRadius). */
function displayRadius(altKm) {
  return RADIUS * (1 + 0.15 * Math.log10(1 + Math.max(0, altKm || 0) / 100)) + 0.8;
}

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'tle') {
    satrecs = (m.lines || []).map(([l1, l2]) => {
      try { return satellite.twoline2satrec(l1, l2); } catch { return null; }
    });
    self.postMessage({ type: 'ready', n: satrecs.length });
    return;
  }
  if (m.type !== 'key') return;
  const n = satrecs.length;
  const t = new Date(m.t);
  const gmst = satellite.gstime(t);
  const xyz = new Float32Array(n * 3);
  const lat = new Float32Array(n);
  const lng = new Float32Array(n);
  const alt = new Float32Array(n);
  const elev = new Float32Array(n);
  const speed = new Float32Array(n);
  const obs = m.observer ? { latitude: m.observer.lat * DEG, longitude: m.observer.lng * DEG, height: 0 } : null;
  for (let i = 0; i < n; i++) {
    const rec = satrecs[i];
    let pv = null;
    try { pv = rec ? satellite.propagate(rec, t) : null; } catch { pv = null; }
    if (!pv || !pv.position || typeof pv.position !== 'object' || !Number.isFinite(pv.position.x)) {
      lat[i] = NaN; lng[i] = NaN; alt[i] = NaN; elev[i] = NaN; speed[i] = NaN;
      xyz[i * 3] = 0; xyz[i * 3 + 1] = 0; xyz[i * 3 + 2] = 0;
      continue;
    }
    const gd = satellite.eciToGeodetic(pv.position, gmst);
    const la = gd.latitude / DEG;
    const lo = gd.longitude / DEG;
    lat[i] = la;
    lng[i] = lo;
    alt[i] = gd.height;
    const r = displayRadius(gd.height);
    const phi = (90 - la) * DEG;
    const theta = (lo + 180) * DEG;
    xyz[i * 3] = -r * Math.sin(phi) * Math.cos(theta);
    xyz[i * 3 + 1] = r * Math.cos(phi);
    xyz[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    const v = pv.velocity;
    speed[i] = v ? Math.hypot(v.x, v.y, v.z) : NaN;
    if (obs) {
      try { elev[i] = satellite.ecfToLookAngles(obs, satellite.eciToEcf(pv.position, gmst)).elevation / DEG; } catch { elev[i] = NaN; }
    } else {
      elev[i] = NaN;
    }
  }
  self.postMessage({ type: 'key', t: m.t, xyz, lat, lng, alt, elev, speed }, [xyz.buffer, lat.buffer, lng.buffer, alt.buffer, elev.buffer, speed.buffer]);
};
