/**
 * Your sky: satellite passes you can see with the naked eye and aircraft near you, from
 * this browser's location. The location stays in this browser (rounded to about 1 km);
 * passes are computed here, in a worker, so nothing about where you are is sent anywhere.
 */
import { appState } from './app-state.js';
import { $, DEG, DEMO, esc, haversineKm, num, store } from './core.js';
import { satCatalog, satrecFor, visualIds } from './satellites.js';
import { data } from './state.js';
import { toast } from './rules.js';
import { flyTo } from './camera.js';

const PASS_HOURS = 36;
const RECOMPUTE_MS = 3 * 3600 * 1000;
const PASS_ALERT_LEAD_MS = 5 * 60 * 1000;
const AIRCRAFT_RANGE_KM = 60;
const AIRCRAFT_OVERHEAD_EL = 40;
const AIRCRAFT_MAX_AGE_MS = 20 * 60 * 1000;
/* Always considered, even if the poller's naked-eye list is missing: ISS, Tiangong, Hubble. */
const ALWAYS_BRIGHT = new Set(['25544', '48274', '20580']);
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export const compass = (az) => COMPASS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];
const when = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/* ----- Location ----- */

let observer = null;
const settings = { passAlerts: true, aircraftAlerts: true };

export function skyObserver() {
  return observer;
}

function saveObserver() {
  store.set('observer', observer);
}

export function locateMe() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This browser cannot share its location.'));
      return;
    }
    navigator.geolocation.getCurrentPosition((p) => {
      /* Rounded to 0.01 deg (about 1 km): enough for pass times, less precise than a home address. */
      observer = {
        lat: Math.round(p.coords.latitude * 100) / 100,
        lng: Math.round(p.coords.longitude * 100) / 100,
        accuracyKm: Math.max(1, Math.round((p.coords.accuracy || 1000) / 1000)),
        at: Date.now()
      };
      saveObserver();
      passes = [];
      requestPasses(true);
      renderSky();
      appState.briefDirty = true;
      resolve(observer);
    }, (err) => {
      reject(new Error(err.code === 1 ? 'Location permission was denied. Allow it for this site in the browser settings.' : 'Location unavailable right now.'));
    }, { enableHighAccuracy: false, timeout: 20000, maximumAge: 10 * 60 * 1000 });
  });
}

export function forgetLocation() {
  observer = null;
  passes = [];
  store.set('observer', null);
  renderSky();
  appState.briefDirty = true;
}

/* ----- Visible passes (pass-worker.js) ----- */

let passes = [];
let passesAt = 0;
let passWorker = null;
let requestId = 0;
let computing = false;
let catalogSize = 0;

function brightSatellites() {
  return satCatalog.filter((s) => ALWAYS_BRIGHT.has(s.noradId) || visualIds.has(s.noradId))
    .slice(0, 400).map((s) => ({ id: s.noradId, name: s.name, l1: s.l1, l2: s.l2 }));
}

export function requestPasses(force = false) {
  if (!observer || DEMO || !satCatalog.length || typeof Worker === 'undefined') return;
  if (computing || (!force && Date.now() - passesAt < RECOMPUTE_MS && catalogSize === satCatalog.length)) return;
  if (!passWorker) {
    passWorker = new Worker('src/pass-worker.js');
    passWorker.onmessage = (e) => {
      const m = e.data;
      if (m.type !== 'passes' || m.requestId !== requestId) return;
      computing = false;
      passes = m.passes;
      passesAt = Date.now();
      renderSky();
      appState.briefDirty = true;
    };
    passWorker.onerror = () => { computing = false; };
  }
  computing = true;
  catalogSize = satCatalog.length;
  requestId++;
  passWorker.postMessage({ type: 'passes', requestId, observer, start: Date.now() - 10 * 60 * 1000, hours: PASS_HOURS, sats: brightSatellites() });
}

export function upcomingPasses() {
  const now = Date.now();
  return passes.filter((p) => p.end > now);
}

/** "Rises NW, highest 62 deg in the SW at 19:14, sets SE" */
export function passPath(p) {
  return `${compass(p.startAz)} ${p.startEl} deg → ${p.maxEl} deg ${compass(p.maxAz)} → ${compass(p.endAz)}`;
}

/* ----- Aircraft near you (poller snapshot, projected along track) ----- */

/** Azimuth, elevation angle and distance of an aircraft from the observer (curvature included). */
function aircraftLook(it) {
  const d = haversineKm(observer.lat, observer.lng, it.lat, it.lng);
  const hKm = (it.baroAltM || 0) / 1000 - (d * d) / (2 * 6371);
  const el = Math.atan2(hKm, Math.max(d, 0.05)) / DEG;
  const y = Math.sin((it.lng - observer.lng) * DEG) * Math.cos(it.lat * DEG);
  const x = Math.cos(observer.lat * DEG) * Math.sin(it.lat * DEG) - Math.sin(observer.lat * DEG) * Math.cos(it.lat * DEG) * Math.cos((it.lng - observer.lng) * DEG);
  const az = ((Math.atan2(y, x) / DEG) + 360) % 360;
  return { d, el, az };
}

export function aircraftNearMe() {
  if (!observer) return [];
  return (data.flights || [])
    .filter((it) => !it.onGround && Number.isFinite(it.baroAltM) && it.baroAltM > 300 && Math.abs(it.lat - observer.lat) < 1 && Math.abs(it.lng - observer.lng) < 1)
    .map((it) => ({ it, ...aircraftLook(it), ageMs: Date.now() - (it.reportedAt || 0) }))
    .filter((a) => a.d <= AIRCRAFT_RANGE_KM && a.el >= 5)
    .sort((a, b) => b.el - a.el);
}

/* ----- Bright satellites above the horizon right now (for the sky chart) ----- */

/** Low-precision solar direction (ECI unit vector), the same model as pass-worker.js. */
function sunEci(date) {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * DEG;
  const L = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const e = (23.439 - 0.00000036 * d) * DEG;
  return { x: Math.cos(L), y: Math.cos(e) * Math.sin(L), z: Math.sin(e) * Math.sin(L) };
}

function sunlit(r, s) {
  const dot = r.x * s.x + r.y * s.y + r.z * s.z;
  return dot > 0 || Math.hypot(r.x - dot * s.x, r.y - dot * s.y, r.z - dot * s.z) > 6378.137;
}

function satellitesUpNow() {
  if (!observer || typeof satellite === 'undefined') return [];
  const now = new Date();
  const gmst = satellite.gstime(now);
  const obs = { latitude: observer.lat * DEG, longitude: observer.lng * DEG, height: 0 };
  const sun = sunEci(now);
  const sunEl = satellite.ecfToLookAngles(obs, satellite.eciToEcf({ x: sun.x * 1.496e8, y: sun.y * 1.496e8, z: sun.z * 1.496e8 }, gmst)).elevation / DEG;
  const out = [];
  for (const s of satCatalog) {
    if (!ALWAYS_BRIGHT.has(s.noradId) && !visualIds.has(s.noradId)) continue;
    const rec = satrecFor(s);
    if (!rec) continue;
    let pv;
    try { pv = satellite.propagate(rec, now); } catch { continue; }
    if (!pv || !pv.position || !Number.isFinite(pv.position.x)) continue;
    const la = satellite.ecfToLookAngles(obs, satellite.eciToEcf(pv.position, gmst));
    if (la.elevation > 0) {
      out.push({ id: s.noradId, name: s.name, az: la.azimuth / DEG, el: la.elevation / DEG, visible: sunEl <= -6 && sunlit(pv.position, sun) && la.elevation / DEG >= 10 });
    }
  }
  return out;
}

/** Sky positions along a pass, every 10 s, for the chart. */
function passTrack(p) {
  const s = satCatalog.find((x) => x.noradId === p.id);
  const rec = s && satrecFor(s);
  if (!rec) return [];
  const obs = { latitude: observer.lat * DEG, longitude: observer.lng * DEG, height: 0 };
  const pts = [];
  for (let t = p.start; t <= p.end; t += 10000) {
    const d = new Date(t);
    let pv;
    try { pv = satellite.propagate(rec, d); } catch { continue; }
    if (!pv || !pv.position) continue;
    const la = satellite.ecfToLookAngles(obs, satellite.eciToEcf(pv.position, satellite.gstime(d)));
    pts.push({ az: la.azimuth / DEG, el: la.elevation / DEG });
  }
  return pts;
}

/* ----- Alerts ----- */

const alerted = new Map();

function skyNotify(title, body) {
  toast({ severity: 'medium', title: `${title}: ${body}` });
  if (appState.notifyEnabled && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, tag: `sky-${title}` }); } catch { /* unsupported here */ }
  }
}

function checkAlerts() {
  if (!observer || document.visibilityState === 'hidden' && !appState.notifyEnabled) return;
  const now = Date.now();
  for (const [k, t] of alerted) if (now - t > 3 * 3600 * 1000) alerted.delete(k);
  if (settings.passAlerts) {
    for (const p of upcomingPasses()) {
      const key = `pass:${p.id}:${p.start}`;
      if (alerted.has(key) || p.start - now > PASS_ALERT_LEAD_MS || p.start < now - 60000) continue;
      alerted.set(key, now);
      const mins = Math.max(0, Math.round((p.start - now) / 60000));
      skyNotify(`${p.name.replace(/\s*\(.*\)/, '')} ${mins ? `in ${mins} min` : 'now'}`,
        `look ${compass(p.startAz)}; highest ${p.maxEl} deg ${compass(p.maxAz)} at ${clock(p.maxT)}${Number.isFinite(p.mag) ? `, magnitude ${p.mag}` : ''}`);
    }
  }
  if (settings.aircraftAlerts) {
    for (const a of aircraftNearMe()) {
      if (a.el < AIRCRAFT_OVERHEAD_EL || a.ageMs > AIRCRAFT_MAX_AGE_MS) continue;
      const key = `air:${a.it.id}`;
      if (alerted.has(key) && now - alerted.get(key) < 30 * 60 * 1000) continue;
      alerted.set(key, now);
      skyNotify(`Aircraft near overhead (estimate)`,
        `${a.it.callsign}, ${num(a.it.baroAltM, 0)} m, look ${compass(a.az)} ${Math.round(a.el)} deg up`);
    }
  }
}

/* ----- Sky tab ----- */

let selectedPass = null;

function skyChart(track, sats, planes) {
  const R = 100;
  const pt = (az, el) => {
    const r = ((90 - Math.max(0, el)) / 90) * R;
    return [R + 10 + r * Math.sin(az * DEG), R + 10 - r * Math.cos(az * DEG)];
  };
  const rings = [0, 30, 60].map((el) => `<circle cx="${R + 10}" cy="${R + 10}" r="${((90 - el) / 90) * R}" class="sky-ring"/>`).join('');
  const labels = [['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([l, az]) => {
    const [x, y] = pt(az, -6);
    return `<text x="${x}" y="${y}" class="sky-label">${l}</text>`;
  }).join('');
  const path = track.length > 1 ? `<polyline class="sky-pass" points="${track.map((p) => pt(p.az, p.el).join(',')).join(' ')}"/>` : '';
  const start = track.length ? `<circle class="sky-start" cx="${pt(track[0].az, track[0].el)[0]}" cy="${pt(track[0].az, track[0].el)[1]}" r="4"/>` : '';
  const dots = sats.map((s) => {
    const [x, y] = pt(s.az, s.el);
    return `<g class="sky-sat${s.visible ? ' lit' : ''}"><circle cx="${x}" cy="${y}" r="3.5"/><text x="${x + 6}" y="${y + 3}">${esc(s.name.replace(/\s*\(.*\)/, '').slice(0, 14))}</text></g>`;
  }).join('');
  const air = planes.map((a) => {
    const [x, y] = pt(a.az, a.el);
    return `<g class="sky-air"><rect x="${x - 3}" y="${y - 3}" width="6" height="6" transform="rotate(45 ${x} ${y})"/><text x="${x + 6}" y="${y + 3}">${esc(a.it.callsign)}</text></g>`;
  }).join('');
  return `<svg class="sky-chart" viewBox="0 0 ${2 * R + 20} ${2 * R + 20}" role="img" aria-label="Sky chart: north up, east right, centre straight overhead">
    ${rings}<line x1="${R + 10}" y1="10" x2="${R + 10}" y2="${2 * R + 10}" class="sky-ring"/><line x1="10" y1="${R + 10}" x2="${2 * R + 10}" y2="${R + 10}" class="sky-ring"/>
    ${labels}${path}${start}${dots}${air}</svg>`;
}

export function renderSky() {
  const el = $('tab-sky');
  if (!el) return;
  if (DEMO) {
    el.innerHTML = '<div class="note">Sky predictions use real satellites; switch to live data to use them.</div>';
    return;
  }
  if (!observer) {
    el.innerHTML = `
      <div class="sky-card">
        <div class="sky-title">Satellites and aircraft above you</div>
        <div class="note">Uses this device's location to list satellite passes you can see with the naked eye in the next ${PASS_HOURS} hours, and aircraft near you, with an alert 5 minutes before each pass. The location is rounded to about 1 km and stays in this browser; it is never sent anywhere.</div>
        <button class="btn on" type="button" data-sky="locate">Use my location</button>
        <div class="sky-err" id="skyErr"></div>
      </div>`;
    return;
  }
  const up = upcomingPasses();
  const nowPlanes = aircraftNearMe();
  const sel = selectedPass && up.find((p) => p.id === selectedPass.id && p.start === selectedPass.start) || up[0] || null;
  const track = sel ? passTrack(sel) : [];
  const status = computing ? 'Computing passes…' : !satCatalog.length ? 'Waiting for satellite data…' : `${up.length} visible pass${up.length === 1 ? '' : 'es'} in the next ${PASS_HOURS} h`;
  el.innerHTML = `
    <div class="sky-card">
      <div class="sky-row"><span>Your location ${num(observer.lat, 2)}, ${num(observer.lng, 2)} (about ${observer.accuracyKm} km)</span>
        <span><button class="btn" type="button" data-sky="locate">Update</button> <button class="btn" type="button" data-sky="forget">Forget</button></span></div>
      <label class="sky-toggle"><input type="checkbox" data-sky-set="passAlerts"${settings.passAlerts ? ' checked' : ''}> Alert 5 minutes before a visible pass</label>
      <label class="sky-toggle"><input type="checkbox" data-sky-set="aircraftAlerts"${settings.aircraftAlerts ? ' checked' : ''}> Alert when an aircraft is about overhead</label>
      <div class="note">For alerts with the page in the background, turn on Notify in the feed.</div>
    </div>
    ${skyChart(track, satellitesUpNow(), nowPlanes)}
    <div class="note sky-legend">${sel ? `Line: ${esc(sel.name)} ${when(sel.start)} (dot where it appears). ` : ''}White dots: bright satellites visible now; grey: above the horizon but in Earth's shadow, in daylight or too low. Diamonds: aircraft. Centre is straight overhead.</div>
    <div class="sky-title">${esc(status)}</div>
    ${up.slice(0, 10).map((p, i) => `
      <button class="sky-pass-row${sel && p.id === sel.id && p.start === sel.start ? ' on' : ''}" type="button" data-pass="${i}">
        <span class="sky-when">${esc(when(p.start))}<small>${Math.max(1, Math.round(p.durationS / 60))} min</small></span>
        <span class="sky-what">${esc(p.name.replace(/\s*\(.*\)/, ''))}${Number.isFinite(p.mag) ? ` <small>mag ${p.mag}</small>` : ''}<small>${esc(passPath(p))}</small></span>
      </button>`).join('') || '<div class="note">No naked-eye passes in this window. Most passes happen within two hours after sunset or before sunrise.</div>'}
    <div class="sky-title">Aircraft near you (within ${AIRCRAFT_RANGE_KM} km)</div>
    ${nowPlanes.slice(0, 8).map((a) => `
      <div class="sky-air-row"><span>${esc(a.it.callsign)}</span><span>${num(a.it.baroAltM, 0)} m · ${num(a.d, 0)} km ${compass(a.az)} · ${Math.round(a.el)} deg up</span>
        <small>${a.it.regional ? 'regional feed' : 'global snapshot'}, position ${Math.round(a.ageMs / 60000)} min old, projected along its track</small></div>`).join('')
      || '<div class="note">None in the latest data. Coverage depends on volunteer ADS-B receivers and is thin away from airports.</div>'}
    <div class="note">Passes: ISS, Tiangong, Hubble and CelesTrak's list of naked-eye satellites, at least 10 deg up, in sunlight while your sky is dark. Aircraft positions are up to 15 to 30 minutes old and projected forward, so treat them as a heads-up and look for the lights.</div>`;
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  const saved = store.get('observer', null);
  if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lng)) observer = saved;
  Object.assign(settings, store.get('skySettings', {}));
  $('tab-sky').addEventListener('click', (e) => {
    const action = e.target.closest('[data-sky]')?.dataset.sky;
    if (action === 'locate') {
      locateMe().catch((err) => {
        const box = $('skyErr');
        if (box) box.textContent = err.message;
        else toast({ severity: 'medium', title: err.message });
      });
      return;
    }
    if (action === 'forget') { forgetLocation(); return; }
    const row = e.target.closest('[data-pass]');
    if (row) {
      const p = upcomingPasses()[Number(row.dataset.pass)];
      if (!p) return;
      selectedPass = p;
      renderSky();
      const s = (data.satellites || []).find((x) => x.id === p.id);
      if (s && Number.isFinite(s.lat)) flyTo(s.lat, s.lng);
    }
  });
  $('tab-sky').addEventListener('change', (e) => {
    const key = e.target.dataset.skySet;
    if (!key) return;
    settings[key] = e.target.checked;
    store.set('skySettings', settings);
  });
  setInterval(() => {
    requestPasses();
    checkAlerts();
  }, 15000);
  setInterval(() => {
    if (document.visibilityState === 'visible' && $('tab-sky').classList.contains('active')) renderSky();
  }, 5000);
  renderSky();
}
