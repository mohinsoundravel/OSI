/** Shared helpers and constants: DOM lookup, escaping, formatting, storage, timed fetch. */
export const $ = (id) => document.getElementById(id);
export const satLibOk = typeof satellite !== 'undefined';

export const DEG = Math.PI / 180;
export const EARTH_KM = 6371;
export const RADIUS = 100;

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
export const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
export const num = (v, digits = 0, unit = '') =>
  (v === null || v === undefined || Number.isNaN(Number(v))) ? 'n/a' : `${Number(v).toFixed(digits)}${unit}`;
export const pos = (it) => `${it.lat.toFixed(3)}, ${it.lng.toFixed(3)}`;
export const fmtTime = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });

export function relTime(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function destination(lat, lng, bearingDeg, distKm) {
  const d = distKm / EARTH_KM;
  const b = bearingDeg * DEG;
  const p1 = lat * DEG;
  const l1 = lng * DEG;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / DEG, lng: (((l2 / DEG) + 540) % 360) - 180 };
}

export async function fetchWithTimeout(url, timeoutMs = 15000, headers = undefined) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (res.status === 401 || res.status === 403) throw new Error(`HTTP ${res.status} (check API key)`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`timeout after ${timeoutMs / 1000}s`);
    if (err instanceof TypeError) throw new Error('network/CORS blocked');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
export const getJson = async (url) => (await fetchWithTimeout(url)).json();

/* Demo mode uses synthetic data and an isolated storage namespace so it never pollutes real history. */
export const DEMO = /(^|[#&?])demo(=1)?($|&)/.test(location.hash.slice(1)) || new URLSearchParams(location.search).has('demo');
const STORE_PREFIX = DEMO ? 'gmdemo.' : 'gm.';
const memStore = new Map();

/* Each demo session starts clean so the scripted events replay as new alerts. */
if (DEMO) {
  try {
    Object.keys(localStorage).filter((k) => k.startsWith('gmdemo.')).forEach((k) => localStorage.removeItem(k));
  } catch { /* storage unavailable */ }
}

export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(STORE_PREFIX + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return memStore.has(key) ? memStore.get(key) : fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
    } catch {
      memStore.set(key, value);
    }
  }
};

export const SEVERITY = { low: 0, medium: 1, high: 2, critical: 3 };
export const SEV_COLOR = { low: '#5a6472', medium: '#f0c75e', high: '#ff8a4c', critical: '#ff4d5e' };
export const GDACS_TYPES = { EQ: 'Earthquake', TC: 'Tropical cyclone', FL: 'Flood', VO: 'Volcano', DR: 'Drought', WF: 'Wildfire' };
export const GDACS_LEVEL = { Green: 0, Orange: 1, Red: 2 };
export const GDACS_COLOR = { Green: '#4ade80', Orange: '#f5a623', Red: '#ff4d5e' };
export const EMERGENCY_SQUAWKS = ['7500', '7600', '7700'];
export const MAX_EVENTS = 300;
export const SEEN_TTL_MS = 3 * 24 * 3600 * 1000;
export const ALERT_WINDOW_MS = 24 * 3600 * 1000;
