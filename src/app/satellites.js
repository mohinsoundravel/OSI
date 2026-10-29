/** All active satellites: catalogue, categories, worker keyframes and per-frame interpolation. */
import { appState } from './app-state.js';
import { DEMO, fetchWithTimeout, getJson, hexToRgb } from './core.js';
import { LAYERS, backendBase, str } from './layers.js';
import { data } from './state.js';
import { evaluate, observerZone } from './rules.js';
import { latLngToVector3 } from './globe.js';
import { displayRadius, layerObjects } from './icons.js';

export let satCatalog = [];

/** TLE texts: the poller's republished copy first (fast, cached), then CelesTrak directly. */
async function fetchTleTexts() {
  const base = backendBase();
  if (base) {
    try {
      const snap = await getJson(`${base.replace(/\/+$/, '')}/tle.json`);
      if (Array.isArray(snap.groups) && snap.groups.length) {
        return snap.groups.slice(0, 10).map((g) => ({ status: 'fulfilled', value: { text: String(g.tle || '').slice(0, 6000000), tag: str(g.tag, 40) } }));
      }
    } catch {
      /* fall back to CelesTrak below */
    }
  }
  const groups = [['active', 'Active satellites']];
  return Promise.allSettled(groups.map(async ([group, tag]) => {
    const res = await fetchWithTimeout(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`, 30000);
    return { text: await res.text(), tag };
  }));
}

/* ----- All active satellites (CelesTrak "active", ~16,000) ----- */
export const SAT_CATS = {
  station: { label: 'Space station', color: '#ffffff', icon: 'satellite', size: 24 },
  india: { label: 'Indian (ISRO, incl. NavIC)', color: '#ff9933', icon: 'satellite', size: 15 },
  gnss: { label: 'Navigation (GPS, GLONASS, Galileo, BeiDou, QZSS)', color: '#f5c542', icon: 'satellite', size: 12 },
  weather: { label: 'Weather and Earth observation', color: '#5ac8fa', icon: 'satellite', size: 12 },
  starlink: { label: 'Starlink', color: '#7f8ea3', icon: 'dot', size: 3.5 },
  oneweb: { label: 'OneWeb', color: '#9b87f5', icon: 'dot', size: 3.5 },
  other: { label: 'Other active', color: '#8aa9f7', icon: 'dot', size: 5 }
};
function satCategory(name) {
  const n = String(name).toUpperCase();
  if (/^ISS[ (]|ZARYA|TIANHE|TIANGONG|^CSS[ (]/.test(n)) return 'station';
  if (n.startsWith('STARLINK')) return 'starlink';
  if (n.startsWith('ONEWEB')) return 'oneweb';
  if (/IRNSS|^NVS-|CARTOSAT|RISAT|OCEANSAT|RESOURCESAT|INSAT|^GSAT[- ]\d|^GSAT-|ASTROSAT|SCATSAT|HYSIS|EMISAT|^EOS-|MICROSAT|SARAL|MEGHA-TROPIQUES|^IRS[- ]|KALPANA|NISAR|ADITYA/.test(n)) return 'india';
  if (/NAVSTAR|^GPS |GLONASS|GALILEO|BEIDOU|^QZS/.test(n)) return 'gnss';
  if (/^NOAA|METOP|METEOSAT|HIMAWARI|^GOES|FENGYUN|^FY-|LANDSAT|SENTINEL|^TERRA|^AQUA|SUOMI|^JPSS|^GCOM|^DMSP|ELEKTRO|ARKTIKA|^SMAP|^GPM|^AURA|SENTINEL|^CALIPSO|^ICESAT|^SWOT|^GOSAT/.test(n)) return 'weather';
  return 'other';
}
export const satrecFor = (rec) => {
  if (!rec.satrec) {
    try { rec.satrec = satellite.twoline2satrec(rec.l1, rec.l2); } catch { rec.satrec = null; }
  }
  return rec.satrec;
};

async function loadSatCatalog() {
  const results = await fetchTleTexts();
  const catalog = [];
  const ids = new Set();
  const errors = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') { errors.push(r.reason.message); continue; }
    const lines = r.value.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i + 2 < lines.length && catalog.length < 30000; i += 3) {
      const [name, l1, l2] = [lines[i], lines[i + 1], lines[i + 2]];
      if (l1[0] !== '1' || l2[0] !== '2') continue;
      const noradId = l1.substring(2, 7).trim();
      if (ids.has(noradId)) continue;
      ids.add(noradId);
      catalog.push({ name: name.slice(0, 40), group: r.value.tag, noradId, l1, l2, cat: satCategory(name), satrec: null });
    }
  }
  if (!catalog.length) throw new Error(errors.join('; ') || 'no TLEs parsed');
  satCatalog = catalog;
}

/* Keyframes from the worker every SAT_KEY_MS; the page interpolates between them. */
const SAT_KEY_MS = 10000;
export let satWorker = null;
let satWorkerReady = null;
const satKeys = new Map();
const satKeyPending = new Set();
export let satItems = [];

function satObserver() {
  const obs = observerZone();
  return obs ? { lat: obs.lat, lng: obs.lng } : null;
}

function startSatWorker() {
  if (satWorker) satWorker.terminate();
  satKeys.clear();
  satKeyPending.clear();
  satWorker = new Worker('src/sat-worker.js');
  satWorkerReady = new Promise((resolve, reject) => {
    satWorker.onerror = (e) => { reject(new Error(e.message || 'satellite worker failed')); };
    satWorker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') resolve(m.n);
      else if (m.type === 'key') onSatKey(m);
    };
  });
  satWorker.postMessage({ type: 'tle', lines: satCatalog.map((r) => [r.l1, r.l2]) });
  return satWorkerReady;
}

function requestSatKey(t) {
  if (!satWorker || satKeys.has(t) || satKeyPending.has(t)) return;
  satKeyPending.add(t);
  satWorker.postMessage({ type: 'key', t, observer: satObserver() });
}

let firstKeyResolve = null;
function onSatKey(k) {
  satKeyPending.delete(k.t);
  satKeys.set(k.t, k);
  for (const t of satKeys.keys()) if (t < Date.now() - 2 * SAT_KEY_MS) satKeys.delete(t);
  /* Item fields (detail, tags, search, rules) follow each keyframe. */
  if (satItems.length === k.lat.length) {
    for (let i = 0; i < satItems.length; i++) {
      const it = satItems[i];
      it.lat = k.lat[i];
      it.lng = k.lng[i];
      it.altKm = k.alt[i];
      it.elevDeg = Number.isFinite(k.elev[i]) ? k.elev[i] : null;
      it.speedKms = Number.isFinite(k.speed[i]) ? k.speed[i] : null;
      it.valid = Number.isFinite(k.lat[i]);
    }
    if (layerObjects.satellites && data.satellites === satItems) evaluate('satellites', satItems);
  }
  if (firstKeyResolve) { firstKeyResolve(); firstKeyResolve = null; }
}

export async function loadAllSatellites() {
  await loadSatCatalog();
  satItems = satCatalog.map((r) => ({
    id: r.noradId, name: r.name, group: r.group, cat: r.cat, lat: 0, lng: 0, altKm: 0, elevDeg: null, speedKms: null,
    valid: false, color: hexToRgb(SAT_CATS[r.cat].color)
  }));
  try {
    if (typeof Worker === 'undefined') throw new Error('no Worker support');
    await startSatWorker();
    const now = Math.floor(Date.now() / SAT_KEY_MS) * SAT_KEY_MS;
    const first = new Promise((resolve) => { firstKeyResolve = resolve; });
    requestSatKey(now);
    requestSatKey(now + SAT_KEY_MS);
    await first;
    return satItems;
  } catch (err) {
    /* Fallback without a worker: the main thread propagates only the notable satellites. */
    satWorker = null;
    const keep = satCatalog.filter((r) => ['station', 'india', 'gnss', 'weather'].includes(r.cat));
    satItems = keep.map((r) => ({ id: r.noradId, name: r.name, group: r.group, cat: r.cat, color: hexToRgb(SAT_CATS[r.cat].color), valid: true }));
    propagateNotable();
    return satItems;
  }
}

export function propagateNotable() {
  const now = new Date();
  const gmst = satellite.gstime(now);
  for (const it of satItems) {
    const rec = satCatalog.find((r) => r.noradId === it.id);
    const sr = rec && satrecFor(rec);
    const pv = sr ? satellite.propagate(sr, now) : null;
    if (!pv || !pv.position || typeof pv.position !== 'object') { it.valid = false; continue; }
    const gd = satellite.eciToGeodetic(pv.position, gmst);
    it.lat = satellite.degreesLat(gd.latitude);
    it.lng = satellite.degreesLong(gd.longitude);
    it.altKm = gd.height;
    it.valid = true;
  }
}

/** Writes interpolated satellite positions into the GPU buffer (called ~30 times a second). */
export function updateSatPositions() {
  if (DEMO || !satWorker || data.satellites !== satItems || !layerObjects.satellites || !LAYERS.satellites.visible) return;
  const nowMs = Date.now();
  const base = Math.floor(nowMs / SAT_KEY_MS) * SAT_KEY_MS;
  requestSatKey(base);
  requestSatKey(base + SAT_KEY_MS);
  if (satKeys.has(base + SAT_KEY_MS)) requestSatKey(base + 2 * SAT_KEY_MS);
  const A = satKeys.get(base);
  const B = satKeys.get(base + SAT_KEY_MS) || A;
  if (!A) return;
  const attr = layerObjects.satellites.geometry.getAttribute('position');
  if (!attr || attr.array.length !== A.xyz.length) return;
  const f = (nowMs - base) / SAT_KEY_MS;
  const out = attr.array;
  const a = A.xyz;
  const b = B.xyz;
  for (let i = 0; i < out.length; i++) out[i] = a[i] + (b[i] - a[i]) * f;
  /* The selected satellite gets an exact position. */
  if (appState.selectedRef && appState.selectedRef.key === 'satellites') {
    const idx = satItems.findIndex((x) => x.id === appState.selectedRef.id);
    const rec = idx >= 0 ? satCatalog.find((r) => r.noradId === appState.selectedRef.id) : null;
    const sr = rec && satrecFor(rec);
    if (sr) {
      const t = new Date(nowMs);
      const pv = satellite.propagate(sr, t);
      if (pv && pv.position && typeof pv.position === 'object') {
        const gd = satellite.eciToGeodetic(pv.position, satellite.gstime(t));
        const it = satItems[idx];
        it.lat = satellite.degreesLat(gd.latitude);
        it.lng = satellite.degreesLong(gd.longitude);
        it.altKm = gd.height;
        const v = latLngToVector3(it.lat, it.lng, displayRadius(it.altKm));
        out[idx * 3] = v.x;
        out[idx * 3 + 1] = v.y;
        out[idx * 3 + 2] = v.z;
      }
    }
  }
  attr.needsUpdate = true;
}
