'use strict';
(() => {
  const $ = (id) => document.getElementById(id);

  if (typeof THREE === 'undefined') {
    $('toasts').innerHTML = '<div class="toast">three.js failed to load. Open this file in a standalone browser tab.</div>';
    return;
  }
  const satLibOk = typeof satellite !== 'undefined';

  /* ===================== Utilities ===================== */

  const DEG = Math.PI / 180;
  const EARTH_KM = 6371;
  const RADIUS = 100;

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const hexToRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };
  const num = (v, digits = 0, unit = '') =>
    (v === null || v === undefined || Number.isNaN(Number(v))) ? 'n/a' : `${Number(v).toFixed(digits)}${unit}`;
  const pos = (it) => `${it.lat.toFixed(3)}, ${it.lng.toFixed(3)}`;
  const fmtTime = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  function relTime(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  }

  function haversineKm(lat1, lng1, lat2, lng2) {
    const dLat = (lat2 - lat1) * DEG;
    const dLng = (lng2 - lng1) * DEG;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function destination(lat, lng, bearingDeg, distKm) {
    const d = distKm / EARTH_KM;
    const b = bearingDeg * DEG;
    const p1 = lat * DEG;
    const l1 = lng * DEG;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: p2 / DEG, lng: (((l2 / DEG) + 540) % 360) - 180 };
  }

  async function fetchWithTimeout(url, timeoutMs = 15000, headers = undefined) {
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
  const getJson = async (url) => (await fetchWithTimeout(url)).json();

  /* Demo mode uses synthetic data and an isolated storage namespace so it never pollutes real history. */
  const DEMO = /(^|[#&?])demo(=1)?($|&)/.test(location.hash.slice(1)) || new URLSearchParams(location.search).has('demo');
  const STORE_PREFIX = DEMO ? 'gmdemo.' : 'gm.';
  const memStore = new Map();

  /* Each demo session starts clean so the scripted events replay as new alerts. */
  if (DEMO) {
    try {
      Object.keys(localStorage).filter((k) => k.startsWith('gmdemo.')).forEach((k) => localStorage.removeItem(k));
    } catch { /* storage unavailable */ }
  }

  const store = {
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

  /* ===================== Constants ===================== */

  const SEVERITY = { low: 0, medium: 1, high: 2, critical: 3 };
  const SEV_COLOR = { low: '#5a6472', medium: '#f0c75e', high: '#ff8a4c', critical: '#ff4d5e' };
  const GDACS_TYPES = { EQ: 'Earthquake', TC: 'Tropical cyclone', FL: 'Flood', VO: 'Volcano', DR: 'Drought', WF: 'Wildfire' };
  const GDACS_LEVEL = { Green: 0, Orange: 1, Red: 2 };
  const GDACS_COLOR = { Green: '#4ade80', Orange: '#f5a623', Red: '#ff4d5e' };
  const EMERGENCY_SQUAWKS = ['7500', '7600', '7700'];
  const MAX_EVENTS = 300;
  const SEEN_TTL_MS = 3 * 24 * 3600 * 1000;
  const ALERT_WINDOW_MS = 24 * 3600 * 1000;

  /* ===================== Layers / sources ===================== */

  const LAYERS = {
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
      label: 'Satellites', source: 'CelesTrak + SGP4', color: '#8aa9f7', size: 3.8, intervalMs: 6 * 3600 * 1000, visible: true,
      describe: (it) => ({
        title: it.name,
        fields: [
          ['NORAD ID', it.id], ['Group', it.group], ['Altitude', num(it.altKm, 0, ' km')],
          ['Speed', num(it.speedKms, 2, ' km/s')], ['Elevation from observer', num(it.elevDeg, 1, ' deg')], ['Sub-point', pos(it)]
        ]
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
        url: it.pageUrl
      })
    },
    alerts: {
      label: 'India alerts', source: 'SACHET + derived flood/heat (poller)', color: '#ff9f0a', size: 6.5,
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
    }
  };

  const UNAVAILABLE_SOURCES = [
    { label: 'Ships (AIS)', why: 'AISStream blocks browser connections by design; needs a backend proxy holding the key.' }
  ];

  /* Windy free tier: image URLs carry tokens that expire after ~10 min, so the layer refreshes every 9 min.
     Search radius per query is capped server-side; larger zones are clamped. */
  const WEBCAM_MAX_RADIUS_KM = 250;
  const WEBCAM_LIMIT_PER_ZONE = 50;

  /* Poller output older than this is flagged as stale: a quiet feed must never look like "no alerts". */
  const BACKEND_STALE_MS = 90 * 60 * 1000;
  const MAX_POLY_VERTICES = 400;

  const str = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : '');

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
  function normalizeBackend(latest) {
    if (!latest || typeof latest !== 'object' || !Array.isArray(latest.active)) throw new Error('unexpected latest.json format');
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
  function autoBackendUrl() {
    const host = location.hostname.toLowerCase();
    if (!host.endsWith('.github.io')) return '';
    const owner = host.slice(0, -'.github.io'.length);
    const repo = location.pathname.split('/').filter(Boolean)[0];
    return owner && repo ? `https://raw.githubusercontent.com/${owner}/${repo}/data` : '';
  }

  const backendBase = () => store.get('backendUrl', '') || autoBackendUrl();

  async function fetchBackendAlerts() {
    const base = backendBase();
    if (!base) throw new Error('no poller data URL set (Sources tab)');
    const url = new URL(`${base.replace(/\/+$/, '')}/latest.json`);
    url.searchParams.set('t', String(Math.floor(Date.now() / 60000)));
    return normalizeBackend(await getJson(url.href));
  }

  /* ----- Flight snapshot from the poller, projected forward between refreshes (dead reckoning) ----- */
  const FLIGHT_STALE_MS = 50 * 60 * 1000;
  const MAX_PROJECTION_S = 45 * 60;
  let flightSnapshot = null;

  function parseFlightSnapshot(snap) {
    if (!snap || !Array.isArray(snap.fields) || !Array.isArray(snap.states)) throw new Error('unexpected flights.json format');
    const col = Object.fromEntries(snap.fields.map((f, i) => [f, i]));
    for (const need of ['icao24', 'lat', 'lng']) if (!(need in col)) throw new Error(`flights.json missing ${need}`);
    const fin = (v) => (Number.isFinite(v) ? v : null);
    const rows = [];
    for (const row of snap.states.slice(0, 30000)) {
      if (!Array.isArray(row)) continue;
      const lat = fin(row[col.lat]);
      const lng = fin(row[col.lng]);
      if (lat === null || lng === null) continue;
      rows.push({
        id: str(row[col.icao24], 8), callsign: str(row[col.callsign], 10) || 'N/A', country: str(row[col.country], 40),
        lat0: lat, lng0: lng, baroAltM: fin(row[col.baroAltM]), onGround: row[col.onGround] === 1 || row[col.onGround] === true,
        velocity: fin(row[col.velocity]), track: fin(row[col.track]), verticalRate: fin(row[col.verticalRate]),
        squawk: typeof row[col.squawk] === 'string' ? row[col.squawk].slice(0, 4) : null,
        t0: fin(row[col.positionTime]) || fin(snap.time) || Date.parse(snap.fetchedAt) / 1000
      });
    }
    return { fetchedAt: Date.parse(snap.fetchedAt) || Date.now(), rows };
  }

  function projectFlights() {
    if (!flightSnapshot) return [];
    const nowS = Date.now() / 1000;
    const items = flightSnapshot.rows.map((f) => {
      const dt = Math.max(0, Math.min(MAX_PROJECTION_S, nowS - f.t0));
      const moving = !f.onGround && Number.isFinite(f.velocity) && f.velocity > 1 && Number.isFinite(f.track);
      const p = moving ? destination(f.lat0, f.lng0, f.track, (f.velocity * dt) / 1000) : { lat: f.lat0, lng: f.lng0 };
      return {
        id: f.id, callsign: f.callsign, country: f.country, lat: p.lat, lng: p.lng,
        baroAltM: f.baroAltM, onGround: f.onGround, velocity: f.velocity, track: f.track, verticalRate: f.verticalRate,
        squawk: f.squawk, altKm: f.baroAltM !== null ? f.baroAltM / 1000 : 0.3, reportedAt: f.t0 * 1000, projected: moving && dt > 30,
        color: flightColor(f.squawk, f.onGround, f.verticalRate)
      };
    });
    const age = Date.now() - flightSnapshot.fetchedAt;
    if (age > FLIGHT_STALE_MS) items.warning = `stale: flight snapshot ${relTime(flightSnapshot.fetchedAt)}`;
    return items;
  }

  /* ===================== Fetchers (normalize to {id, lat, lng, altKm, ...}) ===================== */

  function flightColor(squawk, onGround, verticalRate) {
    if (squawk && EMERGENCY_SQUAWKS.includes(squawk)) return hexToRgb(SEV_COLOR.critical);
    if (onGround) return hexToRgb('#5a6472');
    if (verticalRate !== null && Math.abs(verticalRate) > 2) return hexToRgb('#ffb454');
    return hexToRgb('#7fd8c0');
  }

  let satCatalog = [];

  /** TLE texts: the poller's republished copy first (fast, cached), then CelesTrak directly. */
  async function fetchTleTexts() {
    const base = backendBase();
    if (base) {
      try {
        const snap = await getJson(`${base.replace(/\/+$/, '')}/tle.json`);
        if (Array.isArray(snap.groups) && snap.groups.length) {
          return snap.groups.slice(0, 10).map((g) => ({ status: 'fulfilled', value: { text: String(g.tle || '').slice(0, 200000), tag: str(g.tag, 40) } }));
        }
      } catch {
        /* fall back to CelesTrak below */
      }
    }
    const groups = [['stations', 'Space stations'], ['visual', 'Brightest']];
    return Promise.allSettled(groups.map(async ([group, tag]) => {
      const res = await fetchWithTimeout(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`, 30000);
      return { text: await res.text(), tag };
    }));
  }

  async function loadSatCatalog() {
    const results = await fetchTleTexts();

    const catalog = [];
    const ids = new Set();
    const errors = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') { errors.push(r.reason.message); continue; }
      const lines = r.value.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      for (let i = 0; i + 2 < lines.length; i += 3) {
        const [name, l1, l2] = [lines[i], lines[i + 1], lines[i + 2]];
        if (l1[0] !== '1' || l2[0] !== '2') continue;
        const noradId = l1.substring(2, 7).trim();
        if (ids.has(noradId)) continue;
        try {
          catalog.push({ satrec: satellite.twoline2satrec(l1, l2), name, group: r.value.tag, noradId });
          ids.add(noradId);
        } catch { /* skip malformed TLE */ }
      }
    }
    if (!catalog.length) throw new Error(errors.join('; ') || 'no TLEs parsed');
    satCatalog = catalog;
  }

  function propagateSatellites() {
    const now = new Date();
    const gmst = satellite.gstime(now);
    const obs = observerZone();
    const observerGd = obs ? { latitude: obs.lat * DEG, longitude: obs.lng * DEG, height: 0 } : null;
    const out = [];
    for (const s of satCatalog) {
      const pv = satellite.propagate(s.satrec, now);
      if (!pv || !pv.position || typeof pv.position !== 'object') continue;
      const gd = satellite.eciToGeodetic(pv.position, gmst);
      let elevDeg = null;
      if (observerGd) {
        const look = satellite.ecfToLookAngles(observerGd, satellite.eciToEcf(pv.position, gmst));
        elevDeg = look.elevation / DEG;
      }
      const v = pv.velocity;
      out.push({
        id: s.noradId, name: s.name, group: s.group,
        lat: satellite.degreesLat(gd.latitude), lng: satellite.degreesLong(gd.longitude), altKm: gd.height,
        elevDeg, speedKms: v ? Math.hypot(v.x, v.y, v.z) : null,
        color: elevDeg !== null && elevDeg > 0 ? hexToRgb('#ffffff') : null
      });
    }
    return out;
  }

  const FETCHERS = {
    async flights() {
      /* Preferred: the poller's snapshot (OpenSky blocks direct browser access from other sites). */
      const base = backendBase();
      if (base) {
        const snap = await getJson(`${base.replace(/\/+$/, '')}/flights.json`);
        flightSnapshot = parseFlightSnapshot(snap);
        return projectFlights();
      }
      const data = await getJson('https://opensky-network.org/api/states/all');
      return (data.states || [])
        .filter((s) => s[5] !== null && s[6] !== null)
        .map((s) => ({
          id: s[0], callsign: (s[1] || '').trim() || 'N/A', country: s[2], lng: s[5], lat: s[6],
          baroAltM: s[7], onGround: s[8], velocity: s[9], track: s[10], verticalRate: s[11],
          squawk: s[14] || null, altKm: s[7] !== null ? s[7] / 1000 : 0.3,
          color: flightColor(s[14], s[8], s[11])
        }));
    },
    async quakes() {
      const data = await getJson('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson');
      return (data.features || []).map((f) => {
        const mag = f.properties.mag ?? 0;
        return {
          id: f.id, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], depthKm: f.geometry.coordinates[2],
          mag, place: f.properties.place || 'Unknown location', time: f.properties.time,
          tsunami: f.properties.tsunami === 1, url: f.properties.url, altKm: 0,
          color: hexToRgb(mag >= 5 ? '#ff4d5e' : mag >= 3 ? '#e2554a' : '#7a3a36')
        };
      });
    },
    async gdacs() {
      /* MAP now rejects requests without an event type; SEARCH returns all types (CORS: *). */
      const data = await getJson('https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ;TC;FL;VO;DR;WF&pageSize=100');
      return (data.features || [])
        .filter((f) => String(f.properties && f.properties.iscurrent) === 'true')
        .filter((f) => f.geometry && f.geometry.type === 'Point')
        .map((f) => {
          const p = f.properties || {};
          const level = p.alertlevel || 'Green';
          return {
            id: `${p.eventtype}-${p.eventid}`, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
            type: p.eventtype, name: p.name || p.eventname || 'GDACS event', alertLevel: level,
            country: p.country, from: p.fromdate, severity: p.severitydata && p.severitydata.severitytext,
            url: p.url && p.url.report, altKm: 0, color: hexToRgb(GDACS_COLOR[level] || GDACS_COLOR.Green)
          };
        });
    },
    async eonet() {
      const data = await getJson('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30');
      return (data.events || [])
        .map((ev) => {
          const g = ev.geometry && ev.geometry[ev.geometry.length - 1];
          if (!g || g.type !== 'Point') return null;
          return {
            id: ev.id, lng: g.coordinates[0], lat: g.coordinates[1], date: g.date, title: ev.title,
            category: (ev.categories && ev.categories[0] && ev.categories[0].title) || 'Event',
            url: ev.sources && ev.sources[0] && ev.sources[0].url, altKm: 0
          };
        })
        .filter(Boolean);
    },
    async satellites() {
      if (!satLibOk) throw new Error('satellite.js failed to load');
      await loadSatCatalog();
      return propagateSatellites();
    },
    async webcams() {
      const apiKey = store.get('windyKey', '');
      if (!apiKey) throw new Error('no API key set (Sources tab)');
      const active = zones.filter((z) => z.enabled);
      if (!active.length) return [];

      const results = await Promise.allSettled(active.map(async (z) => {
        const radius = Math.min(z.radiusKm, WEBCAM_MAX_RADIUS_KM);
        const params = new URLSearchParams({
          nearby: `${z.lat},${z.lng},${radius}`,
          include: 'images,location,urls',
          limit: String(WEBCAM_LIMIT_PER_ZONE)
        });
        const res = await fetchWithTimeout(
          `https://api.windy.com/webcams/api/v3/webcams?${params}`, 15000, { 'x-windy-api-key': apiKey }
        );
        const body = await res.json();
        return (body.webcams || []).map((w) => ({ w, zone: z.name }));
      }));

      const rejected = results.filter((r) => r.status === 'rejected');
      if (rejected.length === results.length) throw rejected[0].reason;

      const byId = new Map();
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        for (const { w, zone } of r.value) {
          const loc = w.location || {};
          if (!Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) continue;
          const id = String(w.webcamId ?? w.id);
          if (byId.has(id)) continue;
          const current = (w.images && w.images.current) || {};
          byId.set(id, {
            id, title: w.title || `Webcam ${id}`, status: w.status,
            lat: loc.latitude, lng: loc.longitude, altKm: 0,
            city: loc.city, region: loc.region, country: loc.country, zone,
            imageUrl: current.preview || current.thumbnail || null,
            lastUpdated: w.lastUpdatedOn ? Date.parse(w.lastUpdatedOn) : null,
            pageUrl: (w.urls && (w.urls.detail || (w.urls.player && w.urls.player.day))) || null
          });
        }
      }
      return [...byId.values()];
    },
    alerts: fetchBackendAlerts
  };

  /* ===================== Demo data (synthetic, clearly labelled) ===================== */

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const DEMO_INTERVALS = { flights: 10000, quakes: 15000, gdacs: 20000, eonet: 25000, satellites: 3600000, webcams: 30000, alerts: 20000 };
  const demoPoll = {};
  const nextPoll = (key) => (demoPoll[key] = (demoPoll[key] || 0) + 1);
  const wrapLng = (lng) => ((((lng + 180) % 360) + 360) % 360) - 180;

  const demoFlightBase = (() => {
    const rnd = mulberry32(42);
    const countries = ['India', 'United States', 'United Arab Emirates', 'Germany', 'Singapore', 'Japan', 'United Kingdom', 'Qatar'];
    return Array.from({ length: 900 }, (_, i) => ({
      id: `d${(0xa00000 + i).toString(16)}`,
      callsign: `DMO${String(100 + i)}`,
      country: countries[i % countries.length],
      lat: (rnd() * 120) - 55, lng: (rnd() * 360) - 180,
      track: rnd() * 360, velocity: 180 + rnd() * 90, baroAltM: 8000 + rnd() * 4000,
      verticalRate: rnd() < 0.15 ? (rnd() * 16) - 8 : 0, onGround: rnd() < 0.04
    }));
  })();

  function demoAdvance(f, seconds) {
    if (f.onGround) return { lat: f.lat, lng: f.lng };
    const p = destination(f.lat, f.lng, f.track, (f.velocity * seconds) / 1000);
    return { lat: Math.max(-75, Math.min(75, p.lat)), lng: p.lng };
  }

  const demoStart = Date.now();

  function demoFlight(f, extra = {}) {
    const p = demoAdvance(f, (Date.now() - demoStart) / 1000);
    const merged = { ...f, ...p, squawk: null, ...extra };
    merged.altKm = merged.onGround ? 0.3 : merged.baroAltM / 1000;
    merged.color = flightColor(merged.squawk, merged.onGround, merged.verticalRate);
    return merged;
  }

  function elevationFrom(obsLat, obsLng, lat, lng, altKm) {
    const gamma = haversineKm(obsLat, obsLng, lat, lng) / EARTH_KM;
    const ratio = EARTH_KM / (EARTH_KM + altKm);
    return Math.atan2(Math.cos(gamma) - ratio, Math.sin(gamma)) / DEG;
  }

  const demoSatBase = (() => {
    const rnd = mulberry32(7);
    return Array.from({ length: 60 }, (_, i) => ({
      id: String(90000 + i), name: `DEMOSAT-${i + 1}`, group: 'Demo constellation',
      incl: (20 + rnd() * 78) * DEG, raan: rnd() * 360, phase: rnd() * 2 * Math.PI,
      altKm: i < 40 ? 450 + rnd() * 900 : 19000 + rnd() * 2000
    }));
  })();

  function demoSatellites(at = Date.now()) {
    const t = (at - demoStart) / 1000;
    const obs = observerZone();
    const out = demoSatBase.map((s) => {
      const periodS = 2 * Math.PI * Math.sqrt(((EARTH_KM + s.altKm) * 1000) ** 3 / 3.986e14) / 20;
      const u = s.phase + (2 * Math.PI * t) / periodS;
      const lat = Math.asin(Math.sin(s.incl) * Math.sin(u)) / DEG;
      const lng = wrapLng(s.raan + Math.atan2(Math.cos(s.incl) * Math.sin(u), Math.cos(u)) / DEG - t * 0.02);
      const elevDeg = obs ? elevationFrom(obs.lat, obs.lng, lat, lng, s.altKm) : null;
      return { id: s.id, name: s.name, group: s.group, lat, lng, altKm: s.altKm, elevDeg, speedKms: 7.5,
        color: elevDeg !== null && elevDeg > 0 ? hexToRgb('#ffffff') : null };
    });
    if (obs) {
      /* Demo ISS sweeps across the observer every 3 minutes so the pass rule visibly fires. */
      const cycle = ((t % 180) / 180) * 2 - 1;
      const p = destination(obs.lat, obs.lng, 62, cycle * 6000);
      const elevDeg = elevationFrom(obs.lat, obs.lng, p.lat, p.lng, 420);
      out.push({ id: '25544', name: 'ISS (ZARYA) [DEMO]', group: 'Space stations', lat: p.lat, lng: p.lng,
        altKm: 420, elevDeg, speedKms: 7.66, color: elevDeg > 0 ? hexToRgb('#ffffff') : hexToRgb('#8aa9f7') });
    }
    return out;
  }

  const DEMO_FETCHERS = {
    async flights() {
      const n = nextPoll('flights');
      const out = demoFlightBase.map((f) => demoFlight(f));
      if (n >= 2) {
        out.push(demoFlight({ id: 'd7700a', callsign: 'DMO7700', country: 'India', lat: 13.6, lng: 80.9, track: 220,
          velocity: 140, baroAltM: 3200, verticalRate: -9, onGround: false }, { squawk: '7700' }));
      }
      if (n >= 4) {
        out.push(demoFlight({ id: 'd7600b', callsign: 'DMO7600', country: 'Qatar', lat: 17.5, lng: 66.0, track: 95,
          velocity: 230, baroAltM: 10600, verticalRate: 0, onGround: false }, { squawk: '7600' }));
      }
      return out;
    },
    async quakes() {
      const n = nextPoll('quakes');
      const rnd = mulberry32(1000);
      const out = Array.from({ length: 28 }, (_, i) => {
        const mag = 1 + rnd() * 3.2;
        return { id: `dq${i}`, lat: (rnd() * 140) - 60, lng: (rnd() * 360) - 180, depthKm: 5 + rnd() * 80, mag,
          place: `Demo region ${i + 1}`, time: demoStart - rnd() * 86400000, tsunami: false, url: null, altKm: 0,
          color: hexToRgb(mag >= 3 ? '#e2554a' : '#7a3a36') };
      });
      if (n >= 2) {
        out.push({ id: 'dq-andaman', lat: 12.4, lng: 92.9, depthKm: 18, mag: 5.8, place: 'Andaman Islands region [DEMO]',
          time: Date.now(), tsunami: true, url: null, altKm: 0, color: hexToRgb('#ff4d5e') });
      }
      if (n >= 3) {
        out.push({ id: 'dq-tn', lat: 10.4, lng: 79.6, depthKm: 10, mag: 4.3, place: 'Off Tamil Nadu coast [DEMO]',
          time: Date.now(), tsunami: false, url: null, altKm: 0, color: hexToRgb('#e2554a') });
      }
      return out;
    },
    async gdacs() {
      const n = nextPoll('gdacs');
      const mk = (id, type, name, level, lat, lng, country) => ({ id, type, name, alertLevel: level, country,
        lat, lng, from: demoStart, severity: 'synthetic', url: null, altKm: 0,
        color: hexToRgb(GDACS_COLOR[level]) });
      const out = [
        mk('WF-d1', 'WF', 'Forest fire [DEMO]', 'Green', -24.5, 133.0, 'Australia'),
        mk('FL-d2', 'FL', 'Flood [DEMO]', 'Green', 2.5, 21.0, 'Central Africa'),
        mk('DR-d3', 'DR', 'Drought [DEMO]', 'Orange', 8.0, 38.5, 'Ethiopia')
      ];
      if (n >= 2) out.push(mk('TC-d9', 'TC', 'Cyclone DEMO-01', n >= 4 ? 'Red' : 'Orange', 14.5 + n * 0.3, 86.0 - n * 0.4, 'India'));
      return out;
    },
    async eonet() {
      const n = nextPoll('eonet');
      const out = [
        { id: 'de1', lat: 37.5, lng: -120.5, date: demoStart, title: 'Wildfire, California [DEMO]', category: 'Wildfires', url: null, altKm: 0 },
        { id: 'de2', lat: -8.3, lng: 115.5, date: demoStart, title: 'Volcano activity, Bali [DEMO]', category: 'Volcanoes', url: null, altKm: 0 },
        { id: 'de3', lat: 25.5, lng: 82.0, date: demoStart, title: 'Severe storm, Uttar Pradesh [DEMO]', category: 'Severe Storms', url: null, altKm: 0 }
      ];
      if (n >= 2) out.push({ id: 'de4', lat: 11.4, lng: 76.7, date: Date.now(), title: 'Wildfire, Nilgiris [DEMO]', category: 'Wildfires', url: null, altKm: 0 });
      return out;
    },
    async satellites() {
      return demoSatellites();
    },
    async webcams() {
      nextPoll('webcams');
      const cams = [
        ['Chennai Marina beach', 13.05, 80.28], ['Madurai Meenakshi area', 9.92, 78.12], ['Kodaikanal lake', 10.23, 77.49],
        ['Rameswaram Pamban bridge', 9.28, 79.21], ['Kanyakumari shore', 8.08, 77.55], ['Coimbatore junction', 11.0, 76.96],
        ['Salem junction', 11.66, 78.15], ['Ooty hills', 11.41, 76.69]
      ];
      return cams.map(([name, lat, lng], i) => ({
        id: `dw${i}`, title: `${name} [DEMO]`, status: 'synthetic', lat, lng, altKm: 0,
        city: name.split(' ')[0], region: 'Tamil Nadu', country: 'India', zone: 'Tamil Nadu & coast',
        imageUrl: null, lastUpdated: Date.now(), pageUrl: null
      }));
    },
    async alerts() {
      const n = nextPoll('alerts');
      const nowIso = new Date().toISOString();
      const until = new Date(Date.now() + 36 * 3600 * 1000).toISOString();
      const active = [{
        key: 'sachet:DEMO-HEAT-1', origin: 'official', kind: 'heat', severity: 'high',
        title: 'Heat wave: Madurai, Virudhunagar [DEMO]', summary: 'Heat wave conditions likely; maximum 41-43 C, 4-5 C above normal.',
        instruction: 'Avoid outdoor work between 12:00 and 15:00.', source: 'IMD RMC Chennai (synthetic)', sourceUrl: '',
        zones: ['Tamil Nadu & coast'], expires: until, lat: 9.75, lng: 78.0
      }];
      const sachet = [{ id: 'DEMO-HEAT-1', places: [{ name: 'Madurai', lat: 9.93, lng: 78.12 }, { name: 'Virudhunagar', lat: 9.58, lng: 77.96 }] }];
      if (n >= 2) {
        active.push({
          key: 'sachet:DEMO-DAM-1', origin: 'official', kind: 'dam', severity: 'high',
          title: 'Dam / reservoir release: Salem [DEMO]', summary: 'Mettur Dam shutters opened; surplus release of 30,000 cusecs and rising.',
          instruction: 'People along the Cauvery banks should move to safer places.', source: 'TN SDMA (synthetic)', sourceUrl: '',
          zones: ['Tamil Nadu & coast'], expires: until, lat: 11.66, lng: 78.15
        });
        sachet.push({ id: 'DEMO-DAM-1', places: [{ name: 'Salem', lat: 11.66, lng: 78.15 }, { name: 'Erode', lat: 11.34, lng: 77.72 }] });
        active.push({
          key: 'river:cauvery-mettur:high', origin: 'derived', kind: 'flood', severity: 'high',
          title: 'River rise forecast: Cauvery near Mettur reservoir [DEMO]', summary: 'Forecast peak 4.2x the 7-day mean (250 -> 1,050 m3/s). Model forecast, not an official warning.',
          source: 'GloFAS via Open-Meteo (synthetic)', sourceUrl: '', zones: ['Tamil Nadu & coast'], lat: 11.94, lng: 77.65
        });
      }
      return normalizeBackend({
        generatedAt: nowIso, active,
        layers: {
          sachet,
          rivers: [{ id: 'vaigai-madurai', name: 'Vaigai at Madurai', lat: 9.88, lng: 78.12, baseline: 30, peak: 36, peakDate: '2026-10-25' }],
          heat: [{ id: 'chennai', name: 'Chennai', lat: 13.08, lng: 80.27, region: 'coastal', days: [{ tmax: 33.5 }, { tmax: 34 }] }]
        },
        health: {}
      });
    }
  };

  /* ===================== State ===================== */

  const DEFAULT_ZONES = [
    { id: 'z-tn', name: 'Tamil Nadu & coast', lat: 11.0, lng: 78.6, radiusKm: 450, enabled: true },
    { id: 'z-in', name: 'Indian subcontinent', lat: 22.0, lng: 80.0, radiusKm: 2200, enabled: true },
    { id: 'z-io', name: 'Northern Indian Ocean', lat: 8.0, lng: 75.0, radiusKm: 2800, enabled: false }
  ];

  let zones = store.get('zones', DEFAULT_ZONES);
  const data = {};
  const health = {};
  for (const key of Object.keys(LAYERS)) {
    data[key] = [];
    health[key] = { status: 'idle', lastOk: null, latencyMs: null, failures: 0, error: null, nextAt: null };
  }

  let events = store.get('events', []);
  let unread = 0;
  let notifyEnabled = false;
  let pickMode = false;

  const seen = new Map(Object.entries(store.get('seen', {})).filter(([, ts]) => Date.now() - ts < SEEN_TTL_MS));
  const ruleInit = store.get('ruleInit', {});
  const transitionState = new Map();

  function persistSeen() {
    const cutoff = Date.now() - SEEN_TTL_MS;
    const obj = {};
    for (const [k, ts] of seen) {
      if (ts > cutoff) obj[k] = ts; else seen.delete(k);
    }
    store.set('seen', obj);
  }

  /* ===================== Rules ===================== */

  const RULE_DEFS = [
    {
      id: 'quake_mag', layer: 'quakes', name: 'Earthquake magnitude',
      description: 'Quake at or above a magnitude threshold.',
      defaultScope: 'zones',
      params: [{ key: 'minMag', label: 'Min magnitude', type: 'number', step: 0.1, default: 4.0 }],
      match: (it, p) => it.mag >= p.minMag,
      key: (it) => it.id,
      severity: (it) => (it.mag >= 6.5 ? 'critical' : it.mag >= 5.5 ? 'high' : 'medium'),
      title: (it) => `M${num(it.mag, 1)} ${it.place}`
    },
    {
      id: 'quake_tsunami', layer: 'quakes', name: 'Tsunami-flagged quake',
      description: 'USGS has set the tsunami flag on the event.',
      defaultScope: 'global', params: [],
      match: (it) => it.tsunami,
      key: (it) => it.id,
      severity: () => 'critical',
      title: (it) => `Tsunami flag: M${num(it.mag, 1)} ${it.place}`
    },
    {
      id: 'gdacs_level', layer: 'gdacs', name: 'GDACS alert level',
      description: 'Disaster with alert level at or above threshold. Re-fires on escalation.',
      defaultScope: 'global',
      params: [{ key: 'minLevel', label: 'Min level', type: 'select', options: ['Green', 'Orange', 'Red'], default: 'Orange' }],
      match: (it, p) => (GDACS_LEVEL[it.alertLevel] ?? 0) >= (GDACS_LEVEL[p.minLevel] ?? 1),
      key: (it) => `${it.id}:${it.alertLevel}`,
      severity: (it) => (it.alertLevel === 'Red' ? 'critical' : it.alertLevel === 'Orange' ? 'high' : 'low'),
      title: (it) => `${GDACS_TYPES[it.type] || it.type} ${it.alertLevel}: ${it.name}`
    },
    {
      id: 'eonet_zone', layer: 'eonet', name: 'New natural event',
      description: 'Any newly opened EONET event (fire, storm, volcano, flood).',
      defaultScope: 'zones', params: [],
      match: () => true,
      key: (it) => it.id,
      severity: () => 'medium',
      title: (it) => `${it.category}: ${it.title}`
    },
    {
      id: 'flight_squawk', layer: 'flights', name: 'Emergency squawk',
      description: 'Transponder code 7500 hijack, 7600 radio failure, 7700 emergency.',
      defaultScope: 'global',
      params: [{ key: 'codes', label: 'Codes', type: 'text', default: EMERGENCY_SQUAWKS.join(',') }],
      match: (it, p) => Boolean(it.squawk) && String(p.codes).split(',').map((c) => c.trim()).includes(it.squawk),
      key: (it) => `${it.id}:${it.squawk}`,
      severity: (it) => (it.squawk === '7500' ? 'critical' : it.squawk === '7700' ? 'high' : 'medium'),
      title: (it) => `Squawk ${it.squawk}: ${it.callsign} (${it.country})`
    },
    {
      id: 'sat_pass', layer: 'satellites', name: 'Satellite overhead pass',
      description: 'Fires when a matching satellite rises above the elevation threshold at the observer.',
      defaultScope: 'global', scopeLocked: true, transition: true,
      params: [
        { key: 'nameFilter', label: 'Name contains', type: 'text', default: 'ISS' },
        { key: 'minElev', label: 'Min elevation deg', type: 'number', step: 1, default: 10 },
        { key: 'observerZone', label: 'Observer', type: 'zone', default: 'z-tn' }
      ],
      match: (it, p) => it.elevDeg !== null && it.elevDeg >= p.minElev &&
        it.name.toUpperCase().includes(String(p.nameFilter).toUpperCase()),
      key: (it) => it.id,
      severity: () => 'low',
      title: (it) => `${it.name} overhead, elev ${num(it.elevDeg, 0)} deg`
    },
    {
      id: 'india_alerts', layer: 'alerts', name: 'India alerts (poller)',
      description: 'Official SACHET warnings (IMD, state authorities) and derived flood / heat signals from the scheduled poller.',
      defaultScope: 'global', scopeLocked: true,
      params: [{ key: 'include', label: 'Include', type: 'select', options: ['Official + derived', 'Official only'], default: 'Official + derived' }],
      match: (it, p) => it.isAlert && (p.include !== 'Official only' || it.origin === 'official'),
      key: (it) => it.alertKey,
      severity: (it) => it.alertSeverity,
      title: (it) => `${it.origin === 'official' ? 'Official' : 'Derived'}: ${it.title}`
    }
  ];

  const ruleCfg = store.get('rules', {});
  for (const def of RULE_DEFS) {
    ruleCfg[def.id] = ruleCfg[def.id] || { enabled: true, scope: def.defaultScope, params: {} };
    for (const p of def.params) {
      if (ruleCfg[def.id].params[p.key] === undefined) ruleCfg[def.id].params[p.key] = p.default;
    }
  }

  function observerZone() {
    const id = ruleCfg.sat_pass.params.observerZone;
    return zones.find((z) => z.id === id) || zones[0] || null;
  }

  function zoneContaining(it) {
    return zones.find((z) => z.enabled && haversineKm(z.lat, z.lng, it.lat, it.lng) <= z.radiusKm) || null;
  }

  function evaluate(layerKey, items) {
    let created = 0;
    for (const def of RULE_DEFS) {
      if (def.layer !== layerKey) continue;
      const cfg = ruleCfg[def.id];
      if (!cfg.enabled) continue;

      if (def.transition) {
        const prev = transitionState.get(def.id) || new Set();
        const current = new Set();
        for (const it of items) {
          if (!def.match(it, cfg.params)) continue;
          const k = def.key(it);
          current.add(k);
          if (!prev.has(k)) { createEvent(def, it, cfg, null, false); created++; }
        }
        transitionState.set(def.id, current);
        continue;
      }

      const baseline = !ruleInit[def.id];
      for (const it of items) {
        if (!def.match(it, cfg.params)) continue;
        let zone = null;
        if (cfg.scope === 'zones') {
          zone = zoneContaining(it);
          if (!zone) continue;
        }
        const seenKey = `${def.id}|${def.key(it)}`;
        if (seen.has(seenKey)) continue;
        seen.set(seenKey, Date.now());
        createEvent(def, it, cfg, zone, baseline);
        created++;
      }
      ruleInit[def.id] = true;
    }
    store.set('ruleInit', ruleInit);
    if (created) {
      if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
      persistSeen();
      store.set('events', events);
      renderFeed();
      updateAlertLayer();
      updateRuleCounts();
    }
  }

  function reevaluateAll() {
    for (const key of Object.keys(LAYERS)) {
      if (data[key].length) evaluate(key, data[key]);
    }
  }

  function createEvent(def, it, cfg, zone, baseline) {
    const layer = LAYERS[def.layer];
    const d = layer.describe(it);
    const ev = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      ruleId: def.id, ruleName: def.name, layer: def.layer, kind: layer.label,
      severity: def.severity(it, cfg.params), title: def.title(it), zone: zone ? zone.name : null,
      lat: it.lat, lng: it.lng, altKm: it.altKm || 0, ts: Date.now(), baseline,
      fields: d.fields, url: d.url || null
    };
    events.unshift(ev);
    if (!baseline) {
      unread++;
      notify(ev);
    }
  }

  function notify(ev) {
    if (SEVERITY[ev.severity] >= SEVERITY.medium) toast(ev);
    if (notifyEnabled && SEVERITY[ev.severity] >= SEVERITY.high && 'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(`[${ev.severity.toUpperCase()}] ${ev.ruleName}`, { body: ev.title, tag: ev.id });
      } catch { /* notifications unsupported in this context */ }
    }
  }

  function toast(ev) {
    const host = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span class="dot" style="background:${SEV_COLOR[ev.severity]};color:${SEV_COLOR[ev.severity]}"></span><span><b>${esc(ev.severity.toUpperCase())}</b> ${esc(ev.title)}</span>`;
    host.prepend(el);
    const dismiss = () => {
      el.classList.add('out');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    };
    while (host.children.length > 3) host.lastChild.remove();
    setTimeout(dismiss, 6000);
  }

  /* ===================== Globe ===================== */

  const canvas = $('globe');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 4000);
  camera.position.z = 330;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x03050a, 1);

  scene.add(new THREE.AmbientLight(0x9fb3c8, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 0.55);
  sun.position.set(-180, 160, 260);
  scene.add(sun);

  const globeGroup = new THREE.Group();
  scene.add(globeGroup);

  const earthMaterial = new THREE.MeshPhongMaterial({ color: 0x0b1626, shininess: 12, specular: 0x14233a });
  const earthMesh = new THREE.Mesh(new THREE.SphereGeometry(RADIUS, 96, 64), earthMaterial);
  globeGroup.add(earthMesh);

  /* Atmosphere: back-face fresnel shell, additive. */
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(RADIUS * 1.13, 64, 48),
    new THREE.ShaderMaterial({
      vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'varying vec3 vN; void main(){ float i = pow(0.62 - dot(vN, vec3(0.0, 0.0, 1.0)), 3.2); gl_FragColor = vec4(0.32, 0.62, 1.0, 1.0) * i; }',
      side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false
    })
  );
  scene.add(atmosphere);

  function latLngToVector3(lat, lng, radius) {
    const phi = (90 - lat) * DEG;
    const theta = (lng + 180) * DEG;
    return new THREE.Vector3(
      -radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta)
    );
  }

  function vector3ToLatLng(v) {
    const r = v.length();
    const lat = 90 - Math.acos(v.y / r) / DEG;
    let lng = Math.atan2(v.z, -v.x) / DEG - 180;
    if (lng < -180) lng += 360;
    return { lat, lng };
  }

  /* Graticule every 30 degrees, very faint. */
  (() => {
    const pts = [];
    const push = (a, b) => pts.push(latLngToVector3(a[0], a[1], RADIUS + 0.12), latLngToVector3(b[0], b[1], RADIUS + 0.12));
    for (let lat = -60; lat <= 60; lat += 30) for (let lng = -180; lng < 180; lng += 3) push([lat, lng], [lat, lng + 3]);
    for (let lng = -180; lng < 180; lng += 30) for (let lat = -84; lat < 84; lat += 3) push([lat, lng], [lat + 3, lng]);
    globeGroup.add(new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x6f8fb5, transparent: true, opacity: 0.07, depthWrite: false })
    ));
  })();

  /* ----- Countries: land fill texture + coastline/border lines from world-atlas ----- */

  const WORLD_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json';

  function buildLandTexture(land) {
    const W = 4096;
    const H = 2048;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    const ocean = ctx.createLinearGradient(0, 0, 0, H);
    ocean.addColorStop(0, '#08111e');
    ocean.addColorStop(0.5, '#0a1626');
    ocean.addColorStop(1, '#08111e');
    ctx.fillStyle = ocean;
    ctx.fillRect(0, 0, W, H);

    const px = (lng) => ((lng + 180) / 360) * W;
    const py = (lat) => ((90 - lat) / 180) * H;
    const polygons = land.features.flatMap((f) =>
      f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates);

    ctx.fillStyle = '#1a2b42';
    for (const offset of [-W, 0, W]) {
      ctx.beginPath();
      for (const poly of polygons) {
        for (const ring of poly) {
          let prevLng = null;
          let shift = 0;
          ring.forEach(([lng, lat], i) => {
            if (prevLng !== null && Math.abs(lng - prevLng) > 180) shift += lng < prevLng ? 360 : -360;
            prevLng = lng;
            const x = px(lng + shift) + offset;
            const y = py(lat);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.closePath();
        }
      }
      ctx.fill('evenodd');
    }
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  function buildLines(multiLine, radius, color, opacity) {
    const pts = [];
    for (const line of multiLine.coordinates) {
      for (let i = 1; i < line.length; i++) {
        const [lng1, lat1] = line[i - 1];
        const [lng2, lat2] = line[i];
        if (Math.abs(lng2 - lng1) > 180) continue;
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(lng2 - lng1), Math.abs(lat2 - lat1)) / 2));
        for (let k = 0; k < steps; k++) {
          const t0 = k / steps;
          const t1 = (k + 1) / steps;
          pts.push(
            latLngToVector3(lat1 + (lat2 - lat1) * t0, lng1 + (lng2 - lng1) * t0, radius),
            latLngToVector3(lat1 + (lat2 - lat1) * t1, lng1 + (lng2 - lng1) * t1, radius)
          );
        }
      }
    }
    return new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
    );
  }

  async function loadWorld() {
    if (typeof topojson === 'undefined') throw new Error('topojson-client failed to load');
    const world = await getJson(WORLD_URL);
    earthMaterial.map = buildLandTexture(topojson.feature(world, world.objects.land));
    earthMaterial.color.set(0xffffff);
    earthMaterial.needsUpdate = true;
    globeGroup.add(buildLines(topojson.mesh(world, world.objects.countries, (x, y) => x !== y), RADIUS + 0.18, 0x51677f, 0.55));
    globeGroup.add(buildLines(topojson.mesh(world, world.objects.land), RADIUS + 0.2, 0x7f9cbd, 0.7));
  }

  /* ----- Point sprites ----- */

  function makeDotTexture(soft) {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    if (soft) {
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
      g.addColorStop(0.6, 'rgba(255,255,255,0.18)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
    } else {
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.62, 'rgba(255,255,255,1)');
      g.addColorStop(0.8, 'rgba(255,255,255,0.35)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(c);
  }
  const DOT_TEX = makeDotTexture(false);
  const GLOW_TEX = makeDotTexture(true);

  /* ----- Icon atlas: white glyphs with a dark outline, tinted per point in the shader ----- */

  const ICON = {
    dot: 0, plane: 1, satellite: 2, quake: 3, cyclone: 4, flood: 5, fire: 6, volcano: 7,
    camera: 8, warning: 9, heat: 10, river: 11, drought: 12, dam: 13, storm: 14, event: 15
  };
  const ATLAS_GRID = 4;
  const ATLAS_CELL = 128;

  function drawIcon(ctx, name) {
    const P = (pts) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    };
    const circle = (x, y, r) => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
    };
    switch (name) {
      case 'dot': circle(0, 0, 0.55); return 'fill';
      case 'plane':
        P([[0, -0.95], [0.11, -0.78], [0.12, -0.3], [0.92, 0.12], [0.92, 0.3], [0.12, 0.1], [0.1, 0.6], [0.38, 0.8], [0.38, 0.93],
          [0, 0.82], [-0.38, 0.93], [-0.38, 0.8], [-0.1, 0.6], [-0.12, 0.1], [-0.92, 0.3], [-0.92, 0.12], [-0.12, -0.3], [-0.11, -0.78]]);
        return 'fill';
      case 'satellite':
        ctx.beginPath();
        ctx.rect(-0.95, -0.22, 0.55, 0.44);
        ctx.rect(0.4, -0.22, 0.55, 0.44);
        ctx.rect(-0.4, -0.045, 0.8, 0.09);
        ctx.moveTo(0, -0.34); ctx.lineTo(0.3, 0); ctx.lineTo(0, 0.34); ctx.lineTo(-0.3, 0); ctx.closePath();
        return 'fill';
      case 'quake':
        ctx.beginPath();
        ctx.arc(0, 0, 0.82, 0, Math.PI * 2);
        ctx.moveTo(0.52, 0); ctx.arc(0, 0, 0.52, 0, Math.PI * 2);
        ctx.moveTo(0.22, 0); ctx.arc(0, 0, 0.22, 0, Math.PI * 2);
        return 'stroke';
      case 'cyclone':
        ctx.beginPath();
        ctx.arc(0, 0, 0.2, 0, Math.PI * 2);
        ctx.moveTo(0.2, 0); ctx.bezierCurveTo(0.25, -0.6, -0.35, -0.95, -0.9, -0.55);
        ctx.moveTo(-0.2, 0); ctx.bezierCurveTo(-0.25, 0.6, 0.35, 0.95, 0.9, 0.55);
        return 'stroke';
      case 'flood':
        ctx.beginPath();
        ctx.moveTo(0, -0.95); ctx.bezierCurveTo(0.35, -0.45, 0.62, -0.1, 0.62, 0.25);
        ctx.arc(0, 0.25, 0.62, 0, Math.PI); ctx.bezierCurveTo(-0.62, -0.1, -0.35, -0.45, 0, -0.95);
        return 'fill';
      case 'fire':
        ctx.beginPath();
        ctx.moveTo(0, -0.95); ctx.bezierCurveTo(0.2, -0.5, 0.7, -0.3, 0.62, 0.3);
        ctx.bezierCurveTo(0.58, 0.75, 0.25, 0.92, 0, 0.92); ctx.bezierCurveTo(-0.25, 0.92, -0.62, 0.75, -0.62, 0.3);
        ctx.bezierCurveTo(-0.62, -0.05, -0.35, -0.2, -0.3, -0.5); ctx.bezierCurveTo(-0.1, -0.3, 0, -0.55, 0, -0.95);
        return 'fill';
      case 'volcano':
        P([[-0.92, 0.85], [-0.28, -0.25], [0.28, -0.25], [0.92, 0.85]]);
        ctx.moveTo(-0.05, -0.4); ctx.arc(-0.12, -0.62, 0.2, 0, Math.PI * 2);
        ctx.moveTo(0.42, -0.72); ctx.arc(0.25, -0.72, 0.17, 0, Math.PI * 2);
        return 'fill';
      case 'camera':
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(-0.9, -0.45, 1.8, 1.25, 0.18) : ctx.rect(-0.9, -0.45, 1.8, 1.25);
        ctx.rect(-0.3, -0.7, 0.6, 0.3);
        return 'fill-hole-camera';
      case 'warning':
        P([[0, -0.92], [0.98, 0.82], [-0.98, 0.82]]);
        return 'fill-hole-warning';
      case 'heat':
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(-0.18, -0.92, 0.36, 1.2, 0.18) : ctx.rect(-0.18, -0.92, 0.36, 1.2);
        ctx.moveTo(0.38, 0.52); ctx.arc(0, 0.52, 0.38, 0, Math.PI * 2);
        return 'fill';
      case 'river':
        ctx.beginPath();
        for (const y of [-0.5, 0, 0.5]) {
          ctx.moveTo(-0.9, y);
          ctx.bezierCurveTo(-0.45, y - 0.3, -0.45, y + 0.3, 0, y);
          ctx.bezierCurveTo(0.45, y - 0.3, 0.45, y + 0.3, 0.9, y);
        }
        return 'stroke';
      case 'drought':
        ctx.beginPath();
        ctx.arc(0, 0, 0.42, 0, Math.PI * 2);
        for (let k = 0; k < 8; k++) {
          const a = (k * Math.PI) / 4;
          ctx.moveTo(Math.cos(a) * 0.62, Math.sin(a) * 0.62);
          ctx.lineTo(Math.cos(a) * 0.92, Math.sin(a) * 0.92);
        }
        return 'fill-stroke';
      case 'dam':
        P([[-0.95, -0.75], [-0.15, -0.75], [0.15, 0.85], [-0.95, 0.85]]);
        ctx.moveTo(0.35, -0.35); ctx.lineTo(0.95, -0.35); ctx.moveTo(0.42, 0.05); ctx.lineTo(0.95, 0.05);
        ctx.moveTo(0.5, 0.45); ctx.lineTo(0.95, 0.45);
        return 'fill-stroke';
      case 'storm':
        ctx.beginPath();
        ctx.arc(-0.35, -0.2, 0.38, Math.PI * 0.5, Math.PI * 1.6);
        ctx.arc(0.1, -0.42, 0.42, Math.PI * 1.05, Math.PI * 1.95);
        ctx.arc(0.5, -0.12, 0.35, Math.PI * 1.4, Math.PI * 0.5);
        ctx.closePath();
        ctx.moveTo(0.05, 0.2); ctx.lineTo(-0.25, 0.62); ctx.lineTo(0.02, 0.62); ctx.lineTo(-0.15, 0.98); ctx.lineTo(0.32, 0.45); ctx.lineTo(0.05, 0.45); ctx.lineTo(0.2, 0.2); ctx.closePath();
        return 'fill';
      default:
        P([[0, -0.9], [0.75, 0], [0, 0.9], [-0.75, 0]]);
        return 'fill';
    }
  }

  function buildIconAtlas() {
    const size = ATLAS_GRID * ATLAS_CELL;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    const urls = {};
    for (const [name, index] of Object.entries(ICON)) {
      const col = index % ATLAS_GRID;
      const row = Math.floor(index / ATLAS_GRID);
      ctx.save();
      ctx.translate(col * ATLAS_CELL + ATLAS_CELL / 2, row * ATLAS_CELL + ATLAS_CELL / 2);
      ctx.scale(ATLAS_CELL * 0.4, ATLAS_CELL * 0.4);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const mode = drawIcon(ctx, name);
      const strokeOnly = mode === 'stroke';
      /* Dark halo first for contrast on any background, then the white glyph. */
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.lineWidth = strokeOnly ? 0.42 : 0.26;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#ffffff';
      if (strokeOnly) {
        ctx.lineWidth = 0.17;
        ctx.stroke();
      } else {
        ctx.fill('nonzero');
        if (mode === 'fill-stroke') {
          ctx.lineWidth = 0.16;
          ctx.stroke();
        }
      }
      if (mode === 'fill-hole-warning' || mode === 'fill-hole-camera') {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.beginPath();
        if (mode === 'fill-hole-warning') {
          ctx.rect(-0.08, -0.32, 0.16, 0.6);
          ctx.rect(-0.08, 0.42, 0.16, 0.16);
        } else {
          ctx.arc(0, 0.17, 0.34, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      ctx.restore();

      /* Small standalone copy of each glyph for HTML (legend, chips, tags). */
      const one = document.createElement('canvas');
      one.width = 48;
      one.height = 48;
      one.getContext('2d').drawImage(c, col * ATLAS_CELL, row * ATLAS_CELL, ATLAS_CELL, ATLAS_CELL, 0, 0, 48, 48);
      urls[name] = one.toDataURL('image/png');
    }
    const tex = new THREE.CanvasTexture(c);
    tex.flipY = false;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return { tex, urls };
  }
  const ATLAS = buildIconAtlas();

  const ICON_VERTEX = `
    attribute vec3 aColor;
    attribute float aSize;
    attribute float aIcon;
    attribute vec3 aDir;
    uniform float uScale;
    uniform float uPixelRatio;
    uniform float uAspect;
    varying vec3 vColor;
    varying float vIcon;
    varying float vAngle;
    void main() {
      vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_Position = clip;
      gl_PointSize = aSize * uScale * uPixelRatio;
      vColor = aColor;
      vIcon = aIcon;
      vAngle = 0.0;
      if (dot(aDir, aDir) > 0.0) {
        /* Screen-space heading: project a point slightly ahead along the track. */
        vec4 clip2 = projectionMatrix * modelViewMatrix * vec4(position + aDir, 1.0);
        vec2 d = (clip2.xy / clip2.w - clip.xy / clip.w) * vec2(uAspect, 1.0);
        if (dot(d, d) > 1e-12) vAngle = atan(d.y, d.x) - 1.5707963;
      }
    }`;

  const ICON_FRAGMENT = `
    uniform sampler2D uAtlas;
    uniform float uOpacity;
    varying vec3 vColor;
    varying float vIcon;
    varying float vAngle;
    void main() {
      vec2 p = gl_PointCoord - 0.5;
      vec2 q = vec2(p.x, -p.y);
      float c = cos(-vAngle);
      float s = sin(-vAngle);
      vec2 t = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
      vec2 local = vec2(t.x, -t.y) + 0.5;
      if (local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0) discard;
      float col = mod(vIcon, 4.0);
      float row = floor(vIcon / 4.0 + 0.001);
      vec4 tex = texture2D(uAtlas, (vec2(col, row) + local) / 4.0);
      if (tex.a < 0.06) discard;
      gl_FragColor = vec4(vColor * tex.rgb, tex.a * uOpacity);
    }`;

  function makeIconMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: ATLAS.tex },
        uOpacity: { value: 0 },
        uScale: { value: 1 },
        uPixelRatio: { value: renderer.getPixelRatio() },
        uAspect: { value: window.innerWidth / window.innerHeight }
      },
      vertexShader: ICON_VERTEX,
      fragmentShader: ICON_FRAGMENT,
      transparent: true,
      depthWrite: false
    });
  }

  const LAYER_ICON = { flights: 'plane', quakes: 'quake', gdacs: 'cyclone', eonet: 'fire', satellites: 'satellite', webcams: 'camera', alerts: 'warning' };
  const GDACS_ICON = { 'Tropical cyclone': 'cyclone', Flood: 'flood', Earthquake: 'quake', Volcano: 'volcano', Drought: 'drought', Wildfire: 'fire', TC: 'cyclone', FL: 'flood', EQ: 'quake', VO: 'volcano', DR: 'drought', WF: 'fire' };
  const EONET_ICON = { Wildfires: 'fire', 'Severe Storms': 'storm', Volcanoes: 'volcano', Floods: 'flood', Drought: 'drought', Earthquakes: 'quake' };
  const ALERT_ICON = { dam: 'dam', flood: 'flood', heat: 'heat', cyclone: 'cyclone', rain: 'storm', thunderstorm: 'storm', tsunami: 'warning', earthquake: 'quake' };

  /** Icon, on-screen size (CSS px) and whether the icon turns with the item's heading. */
  function iconFor(key, it) {
    switch (key) {
      case 'flights':
        return it.onGround ? { icon: 'dot', size: 6 } : { icon: 'plane', size: it.squawk && EMERGENCY_SQUAWKS.includes(it.squawk) ? 22 : 15, heading: it.track };
      case 'satellites': return { icon: 'satellite', size: /ISS|ZARYA|TIANGONG|CSS/i.test(it.name || '') ? 24 : 18 };
      case 'quakes': return { icon: 'quake', size: Math.max(10, Math.min(34, 6 + (it.mag || 0) * 4)) };
      case 'gdacs': return { icon: GDACS_ICON[it.type] || 'event', size: it.alertLevel === 'Red' ? 28 : it.alertLevel === 'Orange' ? 24 : 18 };
      case 'eonet': return { icon: EONET_ICON[it.category] || 'event', size: 18 };
      case 'webcams': return { icon: 'camera', size: 16 };
      case 'alerts':
        if (!it.isAlert) return { icon: it.id && it.id.startsWith('river:') ? 'river' : 'heat', size: 13 };
        return { icon: ALERT_ICON[it.kind] || 'warning', size: it.alertSeverity === 'critical' ? 30 : it.alertSeverity === 'high' ? 26 : 22 };
      default: return { icon: 'dot', size: 10 };
    }
  }

  const selectorMesh = new THREE.Mesh(
    new THREE.RingGeometry(2.6, 3.3, 48),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0, depthWrite: false })
  );
  globeGroup.add(selectorMesh);
  let selectorTargetOpacity = 0;
  const Z_AXIS = new THREE.Vector3(0, 0, 1);

  /* Altitude is log-scaled so GPS orbits (~20,000 km) stay on screen next to aircraft (~10 km). */
  const displayRadius = (altKm) => RADIUS * (1 + 0.15 * Math.log10(1 + Math.max(0, altKm || 0) / 100)) + 0.8;

  const layerObjects = {};

  function updateLayer(key) {
    const layer = LAYERS[key];
    const items = data[key];
    const n = items.length;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const sizes = new Float32Array(n);
    const icons = new Float32Array(n);
    const dirs = new Float32Array(n * 3);
    const base = hexToRgb(layer.color);
    items.forEach((it, i) => {
      const r = displayRadius(it.altKm);
      const v = latLngToVector3(it.lat, it.lng, r);
      positions[i * 3] = v.x;
      positions[i * 3 + 1] = v.y;
      positions[i * 3 + 2] = v.z;
      colors.set(it.color || base, i * 3);
      const look = iconFor(key, it);
      sizes[i] = look.size;
      icons[i] = ICON[look.icon] ?? 0;
      if (Number.isFinite(look.heading)) {
        const ahead = destination(it.lat, it.lng, look.heading, 150);
        const w = latLngToVector3(ahead.lat, ahead.lng, r).sub(v).normalize().multiplyScalar(2);
        dirs[i * 3] = w.x;
        dirs[i * 3 + 1] = w.y;
        dirs[i * 3 + 2] = w.z;
      }
    });
    if (!layerObjects[key]) {
      const obj = new THREE.Points(new THREE.BufferGeometry(), makeIconMaterial());
      obj.userData.targetOpacity = layer.visible ? 1 : 0;
      obj.visible = layer.visible;
      /* Draw order: big event icons under small moving ones. */
      obj.renderOrder = { alerts: 1, gdacs: 2, eonet: 3, quakes: 4, webcams: 5, satellites: 6, flights: 7 }[key] || 0;
      layerObjects[key] = obj;
      globeGroup.add(obj);
    }
    const geo = layerObjects[key].geometry;
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aIcon', new THREE.BufferAttribute(icons, 1));
    geo.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
    geo.computeBoundingSphere();
  }

  function setLayerVisible(key, visible) {
    LAYERS[key].visible = visible;
    if (key === 'alerts') alertPolyGroup.visible = visible;
    const obj = layerObjects[key];
    if (!obj) return;
    obj.userData.targetOpacity = visible ? 1 : 0;
    if (visible) obj.visible = true;
  }

  let alertItems = [];
  const alertPoints = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({
      size: 26, map: GLOW_TEX, vertexColors: true, sizeAttenuation: false, transparent: true,
      opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending
    })
  );
  globeGroup.add(alertPoints);

  function updateAlertLayer() {
    const cutoff = Date.now() - ALERT_WINDOW_MS;
    alertItems = events.filter((e) => !e.baseline && e.ts > cutoff && Number.isFinite(e.lat));
    const positions = new Float32Array(alertItems.length * 3);
    const colors = new Float32Array(alertItems.length * 3);
    alertItems.forEach((e, i) => {
      const v = latLngToVector3(e.lat, e.lng, displayRadius(e.altKm) + 0.5);
      positions[i * 3] = v.x;
      positions[i * 3 + 1] = v.y;
      positions[i * 3 + 2] = v.z;
      colors.set(hexToRgb(SEV_COLOR[e.severity]), i * 3);
    });
    alertPoints.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    alertPoints.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    alertPoints.geometry.computeBoundingSphere();
  }

  let zoneLines = [];
  function updateZoneLines() {
    zoneLines.forEach((l) => { globeGroup.remove(l); l.geometry.dispose(); l.material.dispose(); });
    zoneLines = zones.filter((z) => z.enabled).map((z) => {
      const pts = [];
      for (let b = 0; b <= 360; b += 3) {
        const p = destination(z.lat, z.lng, b, z.radiusKm);
        pts.push(latLngToVector3(p.lat, p.lng, RADIUS + 0.45));
      }
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x64d2b4, transparent: true, opacity: 0, depthWrite: false })
      );
      globeGroup.add(line);
      return line;
    });
  }

  /* Outlines of official alert areas (CAP polygons), coloured by severity. */
  const alertPolyGroup = new THREE.Group();
  globeGroup.add(alertPolyGroup);

  function updateAlertPolygons(items) {
    for (const child of [...alertPolyGroup.children]) {
      alertPolyGroup.remove(child);
      child.geometry.dispose();
      child.material.dispose();
    }
    for (const it of items) {
      if (!it.polygons || !it.polygons.length) continue;
      const color = new THREE.Color(SEV_COLOR[it.alertSeverity] || '#ff9f0a');
      for (const ring of it.polygons) {
        const pts = ring.map(([lng, lat]) => latLngToVector3(lat, lng, RADIUS + 0.55));
        const line = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false })
        );
        alertPolyGroup.add(line);
      }
    }
  }

  function placeSelector(lat, lng, altKm) {
    const v = latLngToVector3(lat, lng, displayRadius(altKm) + 0.3);
    selectorMesh.position.copy(v);
    selectorMesh.quaternion.setFromUnitVectors(Z_AXIS, v.clone().normalize());
    selectorTargetOpacity = 0.95;
  }
  function hideSelector() { selectorTargetOpacity = 0; }

  /* ----- Camera: inertial drag, eased zoom, pinch, spring fly-to, idle auto-rotate ----- */

  const ZOOM_MIN = 140;
  const ZOOM_MAX = 900;
  const LAT_LIMIT = 1.25;
  const cam = {
    zoomTarget: 330, vx: 0, vy: 0, fly: null,
    autoSpeed: 0, lastInteraction: performance.now(), idleResumeMs: 9000, autoMax: 0.045
  };
  const pointers = new Map();
  let pinchDist = 0;
  let dragMoved = false;
  let downAt = 0;
  let lastMove = 0;
  let downPos = { x: 0, y: 0 };

  const clampLat = (x) => Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, x));
  const wrapAngle = (a) => ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;

  function touch() { cam.lastInteraction = performance.now(); }

  function flyTo(lat, lng, zoom = null) {
    touch();
    cam.vx = 0;
    cam.vy = 0;
    const targetY = Math.PI / 2 - (lng + 180) * DEG;
    const y = globeGroup.rotation.y + wrapAngle(targetY - globeGroup.rotation.y);
    cam.fly = { x: clampLat(lat * DEG), y };
    if (zoom !== null) cam.zoomTarget = zoom;
    else if (cam.zoomTarget > 300) cam.zoomTarget = 260;
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      pinchDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    }
    dragMoved = false;
    downPos = { x: e.clientX, y: e.clientY };
    downAt = performance.now();
    lastMove = downAt;
    cam.vx = 0;
    cam.vy = 0;
    cam.fly = null;
    canvas.classList.add('dragging');
    touch();
  });

  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const now = performance.now();
    const cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);
    touch();

    if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      if (pinchDist > 0) cam.zoomTarget = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cam.zoomTarget * (pinchDist / d)));
      pinchDist = d;
      dragMoved = true;
      return;
    }

    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    if (Math.hypot(cur.x - downPos.x, cur.y - downPos.y) > 6) dragMoved = true;
    const k = 0.0042 * (camera.position.z / 330);
    globeGroup.rotation.y += dx * k;
    globeGroup.rotation.x = clampLat(globeGroup.rotation.x + dy * k);
    const dt = Math.max(8, now - lastMove) / 1000;
    cam.vy = 0.6 * cam.vy + 0.4 * ((dx * k) / dt);
    cam.vx = 0.6 * cam.vx + 0.4 * ((dy * k) / dt);
    lastMove = now;
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) {
      canvas.classList.remove('dragging');
      if (performance.now() - lastMove > 80) { cam.vx = 0; cam.vy = 0; }
      if (!dragMoved && performance.now() - downAt < 450) handleGlobeClick(e.clientX, e.clientY);
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    touch();
    const factor = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    cam.zoomTarget = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cam.zoomTarget * factor));
  }, { passive: false });

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  /** Finds what is under a screen point: an alert halo, a layer item, or nothing. */
  function pickAt(clientX, clientY) {
    pointer.x = (clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    raycaster.params.Points.threshold = 2.2 * (camera.position.z / 330);
    const earthHit = raycaster.intersectObject(earthMesh)[0];
    const maxDist = earthHit ? earthHit.distance + 4 : Infinity;
    const alertHit = raycaster.intersectObject(alertPoints).find((h) => h.distance < maxDist);
    if (alertHit && alertItems[alertHit.index]) return { alert: alertItems[alertHit.index] };
    let best = null;
    for (const [key, obj] of Object.entries(layerObjects)) {
      if (!LAYERS[key].visible) continue;
      const hit = raycaster.intersectObject(obj).find((h) => h.distance < maxDist);
      if (hit && (!best || hit.distanceToRay < best.hit.distanceToRay)) best = { key, hit };
    }
    if (!best) return null;
    const it = data[best.key][best.hit.index];
    return it ? { key: best.key, it, index: best.hit.index } : null;
  }

  /* Desktop hover: highlight and tag whatever is under the cursor. */
  let hovered = null;
  let hoverPending = false;
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || pointers.size || hoverPending) return;
    hoverPending = true;
    const x = e.clientX;
    const y = e.clientY;
    setTimeout(() => {
      hoverPending = false;
      const hit = pickMode ? null : pickAt(x, y);
      const next = hit && hit.key ? { key: hit.key, id: hit.it.id } : null;
      if (JSON.stringify(next) !== JSON.stringify(hovered)) {
        hovered = next;
        tagsDirty = true;
      }
      canvas.style.cursor = hit ? 'pointer' : '';
    }, 40);
  });
  canvas.addEventListener('pointerleave', () => {
    if (hovered) {
      hovered = null;
      tagsDirty = true;
    }
  });

  function handleGlobeClick(clientX, clientY) {
    if (pickMode) {
      pointer.x = (clientX / window.innerWidth) * 2 - 1;
      pointer.y = -(clientY / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(earthMesh)[0];
      if (!hit) return;
      const ll = vector3ToLatLng(globeGroup.worldToLocal(hit.point.clone()));
      const form = $('zoneForm');
      form.elements.lat.value = ll.lat.toFixed(3);
      form.elements.lng.value = ll.lng.toFixed(3);
      setPickMode(false);
      return;
    }

    const hit = pickAt(clientX, clientY);
    if (hit && hit.alert) showEventDetail(hit.alert);
    else if (hit) showItemDetail(hit.key, hit.it);
    else if (isCompact()) closePanels();
  }

  /* ===================== Tags (smart labels), paths, day/night ===================== */

  const tagHost = $('tags');
  const TAG_POOL = [];
  let tagsDirty = true;
  let tagSet = [];
  let lastTagPick = 0;
  let selectedRef = null;

  const SEV_RANK_N = { low: 0, medium: 1, high: 2, critical: 3 };
  const clip = (str, n) => (str.length > n ? `${str.slice(0, n - 1)}\u2026` : str);

  function tagText(key, it) {
    switch (key) {
      case 'flights': {
        if (it.squawk && EMERGENCY_SQUAWKS.includes(it.squawk)) return `${it.callsign} \u00b7 SQK ${it.squawk}`;
        const fl = it.onGround ? 'GND' : Number.isFinite(it.baroAltM) ? `FL${String(Math.round(it.baroAltM * 3.28084 / 100)).padStart(3, '0')}` : '';
        const spd = Number.isFinite(it.velocity) && !it.onGround ? `${Math.round(it.velocity * 3.6)} km/h` : '';
        return [it.callsign, fl, spd].filter(Boolean).join(' \u00b7 ');
      }
      case 'satellites': return `${clip((it.name || '').replace(/\s*\(.*?\)/g, ''), 18)} \u00b7 ${Math.round(it.altKm)} km`;
      case 'quakes': return `M${(it.mag || 0).toFixed(1)}${it.tsunami ? ' \u00b7 tsunami' : ''}`;
      case 'gdacs': return clip(`${it.alertLevel} \u00b7 ${it.name}`, 30);
      case 'eonet': return clip(it.title || '', 26);
      case 'webcams': return clip((it.title || '').replace(/\s*\[DEMO\]/, ''), 22);
      case 'alerts': return clip((it.title || '').replace(/^Official: |^Derived: /, ''), 32);
      default: return '';
    }
  }

  function tagPriority(key, it, zoom) {
    const id = it.id;
    if (selectedRef && selectedRef.key === key && selectedRef.id === id) return 1000;
    if (hovered && hovered.key === key && hovered.id === id) return 900;
    switch (key) {
      case 'alerts': return it.isAlert ? 500 + 50 * (SEV_RANK_N[it.alertSeverity] || 0) : zoom < 190 ? 60 : -1;
      case 'flights': return it.squawk && EMERGENCY_SQUAWKS.includes(it.squawk) ? 600 : zoom < 210 ? 40 : -1;
      case 'gdacs': return it.alertLevel === 'Red' ? 450 : it.alertLevel === 'Orange' ? 400 : zoom < 230 ? 70 : -1;
      case 'quakes': return it.mag >= 5 ? 300 + it.mag : it.mag >= 3.5 && zoom < 250 ? 100 + it.mag : zoom < 170 ? 20 : -1;
      case 'satellites': return /ISS|ZARYA|TIANGONG|CSS/i.test(it.name || '') ? 350 : zoom < 260 ? 80 : -1;
      case 'eonet': return zoom < 260 ? 120 : -1;
      case 'webcams': return zoom < 200 ? 30 : -1;
      default: return -1;
    }
  }

  const tmpV = new THREE.Vector3();
  const camDir = new THREE.Vector3();

  /** Screen position of item i in a layer, or null if it is behind the globe or off screen. */
  function screenPos(key, i) {
    const obj = layerObjects[key];
    const attr = obj && obj.geometry.getAttribute('position');
    if (!attr || i >= attr.count) return null;
    tmpV.fromBufferAttribute(attr, i).applyMatrix4(globeGroup.matrixWorld);
    camDir.copy(camera.position).normalize();
    if (tmpV.clone().normalize().dot(camDir) < 0.1) return null;
    tmpV.project(camera);
    const x = (tmpV.x + 1) / 2 * window.innerWidth;
    const y = (1 - tmpV.y) / 2 * window.innerHeight;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null;
    return { x, y };
  }

  /* Keep tags out from under panels, the search bar and the chip row. */
  function overPanels(x, y) {
    if (isCompact()) {
      const sheetOpen = $('left').classList.contains('open') || $('right').classList.contains('open');
      return y < 70 || (sheetOpen && y > window.innerHeight * 0.4) || y > window.innerHeight - 130;
    }
    return x < 344 || x > window.innerWidth - 344 || y < 104;
  }

  function pickTags() {
    const zoom = camera.position.z;
    const candidates = [];
    for (const key of Object.keys(LAYERS)) {
      if (!LAYERS[key].visible || !layerObjects[key]) continue;
      const items = data[key];
      for (let i = 0; i < items.length; i++) {
        const pr = tagPriority(key, items[i], zoom);
        if (pr < 0) continue;
        candidates.push({ key, i, pr });
      }
    }
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const placed = [];
    const max = isCompact() ? 14 : 30;
    const scored = [];
    for (const c of candidates) {
      const p = screenPos(c.key, c.i);
      if (!p || (c.pr < 900 && overPanels(p.x, p.y))) continue;
      scored.push({ ...c, ...p, d: Math.hypot(p.x - cx, p.y - cy) });
    }
    scored.sort((a, b) => b.pr - a.pr || a.d - b.d);
    for (const c of scored) {
      if (placed.length >= max) break;
      const it = data[c.key][c.i];
      const text = tagText(c.key, it);
      if (!text) continue;
      const w = text.length * 6.1 + 26;
      /* Flip to the left of the icon near the right edge so tags never run off screen. */
      const rightLimit = isCompact() ? window.innerWidth - 8 : window.innerWidth - 352;
      const flip = c.x + 14 + w > rightLimit;
      const box = { x: flip ? c.x - 14 - w : c.x + 14, y: c.y - 11, w, h: 22 };
      if (c.pr < 900 && placed.some((b) => box.x < b.x + b.w + 4 && box.x + box.w + 4 > b.x && box.y < b.y + b.h + 2 && box.y + box.h + 2 > b.y)) continue;
      placed.push({ ...box, key: c.key, i: c.i, id: it.id, text, pr: c.pr, flip });
    }
    tagSet = placed;

    /* Keep the selection ring on a moving item (satellites, projected flights). */
    if (selectedRef) {
      const it = data[selectedRef.key] && data[selectedRef.key].find((x) => x.id === selectedRef.id);
      if (it) placeSelector(it.lat, it.lng, it.altKm);
    }
  }

  function renderTags(now) {
    if (tagsDirty || now - lastTagPick > 200) {
      pickTags();
      lastTagPick = now;
      tagsDirty = false;
    }
    while (TAG_POOL.length < tagSet.length) {
      const el = document.createElement('div');
      el.className = 'gtag';
      el.innerHTML = '<span class="ic"></span><span></span>';
      tagHost.appendChild(el);
      TAG_POOL.push(el);
    }
    TAG_POOL.forEach((el, n) => {
      const t = tagSet[n];
      if (!t) {
        el.style.opacity = '0';
        return;
      }
      const items = data[t.key];
      const p = items[t.i] && items[t.i].id === t.id ? screenPos(t.key, t.i) : null;
      if (!p) {
        el.style.opacity = '0';
        return;
      }
      if (el.dataset.text !== t.text) {
        el.dataset.text = t.text;
        el.lastChild.textContent = t.text;
      }
      const icon = iconFor(t.key, items[t.i]).icon;
      if (el.dataset.icon !== icon) {
        el.dataset.icon = icon;
        el.firstChild.style.setProperty('--m', `url(${ATLAS.urls[icon]})`);
      }
      const color = t.key === 'alerts' && items[t.i].alertSeverity ? SEV_COLOR[items[t.i].alertSeverity] : LAYERS[t.key].color;
      el.style.setProperty('--c', color);
      el.classList.toggle('focus', t.pr >= 900);
      const x = t.flip ? p.x - 14 - el.offsetWidth : p.x + 14;
      el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(p.y - 11)}px, 0)`;
      el.style.opacity = '1';
    });
  }

  /* Selected-item paths: orbit for satellites, projected 30-minute track for flights. */
  let pathLine = null;
  let pathUpdated = 0;

  function clearPath() {
    if (pathLine) {
      globeGroup.remove(pathLine);
      pathLine.geometry.dispose();
      pathLine.material.dispose();
      pathLine = null;
    }
  }

  function computePath(key, it) {
    const pts = [];
    if (key === 'satellites') {
      const now = Date.now();
      if (DEMO) {
        for (let k = 0; k <= 100; k++) {
          const s = demoSatellites(now + k * 60000).find((x) => x.id === it.id);
          if (s) pts.push(latLngToVector3(s.lat, s.lng, displayRadius(s.altKm)));
        }
      } else if (satLibOk) {
        const rec = satCatalog.find((s) => s.noradId === it.id);
        if (!rec) return pts;
        for (let k = 0; k <= 100; k++) {
          const t = new Date(now + k * 60000);
          const pv = satellite.propagate(rec.satrec, t);
          if (!pv || !pv.position || typeof pv.position !== 'object') continue;
          const gd = satellite.eciToGeodetic(pv.position, satellite.gstime(t));
          pts.push(latLngToVector3(satellite.degreesLat(gd.latitude), satellite.degreesLong(gd.longitude), displayRadius(gd.height)));
        }
      }
    } else if (key === 'flights' && !it.onGround && Number.isFinite(it.track) && Number.isFinite(it.velocity)) {
      const r = displayRadius(it.altKm);
      for (let k = 0; k <= 30; k++) {
        const p = destination(it.lat, it.lng, it.track, (it.velocity * k * 60) / 1000);
        pts.push(latLngToVector3(p.lat, p.lng, r));
      }
    }
    return pts;
  }

  function updatePath(force = false) {
    if (!selectedRef || !['satellites', 'flights'].includes(selectedRef.key)) {
      clearPath();
      return;
    }
    if (!force && performance.now() - pathUpdated < 20000) return;
    const it = data[selectedRef.key].find((x) => x.id === selectedRef.id);
    clearPath();
    if (!it) return;
    const pts = computePath(selectedRef.key, it);
    if (pts.length < 2) return;
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineDashedMaterial({ color: LAYERS[selectedRef.key].color, dashSize: 1.6, gapSize: 1.1, transparent: true, opacity: 0.85, depthWrite: false });
    pathLine = new THREE.Line(geo, mat);
    pathLine.computeLineDistances();
    globeGroup.add(pathLine);
    pathUpdated = performance.now();
  }

  /* Night side shading from the real sun position (subsolar point). */
  const nightMaterial = new THREE.ShaderMaterial({
    uniforms: { uSun: { value: new THREE.Vector3(1, 0, 0) } },
    vertexShader: 'varying vec3 vN; void main(){ vN = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 uSun; varying vec3 vN; void main(){ float d = dot(vN, uSun); float night = smoothstep(0.06, -0.14, d); gl_FragColor = vec4(0.0, 0.012, 0.045, night * 0.58); }',
    transparent: true,
    depthWrite: false
  });
  const nightMesh = new THREE.Mesh(new THREE.SphereGeometry(RADIUS + 0.1, 96, 64), nightMaterial);
  nightMesh.renderOrder = -1;
  globeGroup.add(nightMesh);

  function updateSun() {
    const now = new Date();
    const start = Date.UTC(now.getUTCFullYear(), 0, 0);
    const dayOfYear = (now.getTime() - start) / 86400000;
    const decl = -23.44 * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
    const hours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    const lng = ((((-15 * (hours - 12)) + 540) % 360) - 180);
    nightMaterial.uniforms.uSun.value.copy(latLngToVector3(decl, lng, 1).normalize());
  }
  updateSun();
  setInterval(updateSun, 60000);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  /* Frame-rate independent exponential smoothing factor. */
  const smooth = (rate, dt) => 1 - Math.exp(-rate * dt);

  let lastFrame = performance.now();
  let firstFrame = true;

  function animate(now) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;
    const dragging = pointers.size > 0;

    if (cam.fly) {
      const f = smooth(4.2, dt);
      globeGroup.rotation.x += (cam.fly.x - globeGroup.rotation.x) * f;
      globeGroup.rotation.y += (cam.fly.y - globeGroup.rotation.y) * f;
      if (Math.abs(cam.fly.x - globeGroup.rotation.x) < 0.0005 && Math.abs(cam.fly.y - globeGroup.rotation.y) < 0.0005) cam.fly = null;
    } else if (!dragging) {
      globeGroup.rotation.y += cam.vy * dt;
      globeGroup.rotation.x = clampLat(globeGroup.rotation.x + cam.vx * dt);
      const decay = Math.exp(-3.4 * dt);
      cam.vx *= decay;
      cam.vy *= decay;
    }

    const idle = !dragging && !cam.fly && now - cam.lastInteraction > cam.idleResumeMs && selectorTargetOpacity === 0;
    cam.autoSpeed += ((idle ? cam.autoMax : 0) - cam.autoSpeed) * smooth(idle ? 0.6 : 6, dt);
    globeGroup.rotation.y += cam.autoSpeed * dt;

    camera.position.z += (cam.zoomTarget - camera.position.z) * smooth(8, dt);

    /* Icons grow a little as you zoom in, like map symbols. */
    const iconScale = Math.max(0.85, Math.min(1.7, 330 / camera.position.z));
    const aspect = window.innerWidth / window.innerHeight;
    for (const obj of Object.values(layerObjects)) {
      const m = obj.material;
      m.opacity += (obj.userData.targetOpacity - m.opacity) * smooth(7, dt);
      if (obj.userData.targetOpacity === 0 && m.opacity < 0.01) obj.visible = false;
      if (m.uniforms) {
        m.uniforms.uOpacity.value = m.opacity;
        m.uniforms.uScale.value = iconScale;
        m.uniforms.uAspect.value = aspect;
        m.uniforms.uPixelRatio.value = renderer.getPixelRatio();
      }
    }
    for (const l of zoneLines) l.material.opacity += (0.6 - l.material.opacity) * smooth(4, dt);
    for (const l of alertPolyGroup.children) l.material.opacity += (0.9 - l.material.opacity) * smooth(4, dt);

    const sm = selectorMesh.material;
    sm.opacity += (selectorTargetOpacity - sm.opacity) * smooth(9, dt);
    selectorMesh.visible = sm.opacity > 0.01;
    /* Keep the selection ring a constant on-screen size at any zoom level. */
    selectorMesh.scale.setScalar((1 + 0.12 * Math.sin(now / 420)) * (camera.position.z / 330));

    alertPoints.material.size = 22 + 8 * (0.5 + 0.5 * Math.sin(now / 520));

    renderer.render(scene, camera);
    globeGroup.updateMatrixWorld();
    renderTags(now);
    updatePath();
    if (firstFrame) {
      firstFrame = false;
      canvas.classList.add('ready');
    }
  }

  /* ===================== UI: detail ===================== */

  const isHttps = (u) => typeof u === 'string' && /^https:\/\//.test(u);

  function renderDetail({ kind, title, fields, url, severity, meta = [], image = null, imageLink = null }) {
    const el = $('detail');
    const rows = meta.concat(fields).map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
    const link = isHttps(url)
      ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Source report</a>` : '<span></span>';
    const media = isHttps(image) ? `
      <figure class="cam">
        <a href="${esc(isHttps(imageLink) ? imageLink : image)}" target="_blank" rel="noopener noreferrer">
          <img src="${esc(image)}" alt="${esc(title)}" loading="lazy" referrerpolicy="no-referrer">
        </a>
        <figcaption>Webcams provided by <a href="https://www.windy.com/" target="_blank" rel="noopener noreferrer">windy.com</a></figcaption>
      </figure>` : '';
    el.innerHTML = `
      <div class="kind"${severity ? ` style="color:${SEV_COLOR[severity]}"` : ''}>${esc(kind)}${severity ? ` &middot; ${esc(severity)}` : ''}</div>
      <h2>${esc(title)}</h2>${media}${rows}
      <div class="detail-actions">${link}<button class="btn" data-action="close-detail">Close</button></div>`;
    const img = el.querySelector('.cam img');
    if (img) {
      img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
      img.addEventListener('error', () => {
        img.closest('a').outerHTML = '<div class="cam-err">Image expired or unavailable. It refreshes on the next webcam poll.</div>';
      }, { once: true });
    }
    el.scrollTop = 0;
    $('detailWrap').classList.add('open');
    openPanel('right');
  }

  function closeDetail() {
    selectedRef = null;
    tagsDirty = true;
    updatePath(true);
    $('detailWrap').classList.remove('open');
    selectedEventId = null;
    document.querySelectorAll('.ev.selected').forEach((n) => n.classList.remove('selected'));
    hideSelector();
  }

  function showItemDetail(key, it) {
    selectedRef = { key, id: it.id };
    tagsDirty = true;
    updatePath(true);
    selectedEventId = null;
    document.querySelectorAll('.ev.selected').forEach((n) => n.classList.remove('selected'));
    const d = LAYERS[key].describe(it);
    renderDetail({ kind: LAYERS[key].label, title: d.title, fields: d.fields, url: d.url, image: d.image, imageLink: d.imageLink });
    placeSelector(it.lat, it.lng, it.altKm);
  }

  let selectedEventId = null;

  function showEventDetail(ev) {
    selectedRef = null;
    tagsDirty = true;
    updatePath(true);
    selectedEventId = ev.id;
    document.querySelectorAll('.ev').forEach((n) => n.classList.toggle('selected', n.dataset.ev === ev.id));
    renderDetail({
      kind: ev.ruleName, title: ev.title, fields: ev.fields, url: ev.url, severity: ev.severity,
      meta: [['Detected', fmtTime(ev.ts)], ...(ev.zone ? [['Zone', ev.zone]] : []), ['Baseline', ev.baseline ? 'yes' : 'no']]
    });
    placeSelector(ev.lat, ev.lng, ev.altKm);
    flyTo(ev.lat, ev.lng);
  }

  $('detail').addEventListener('click', (e) => {
    if (e.target.dataset.action === 'close-detail') closeDetail();
  });

  /* ===================== UI: feed ===================== */

  const renderedFeedIds = new Set();
  let lastUnread = 0;

  function renderFeed({ animate = true } = {}) {
    const minSev = SEVERITY[$('sevFilter').value] ?? 0;
    const hideBaseline = $('hideBaseline').checked;
    const list = events.filter((e) => SEVERITY[e.severity] >= minSev && !(hideBaseline && e.baseline)).slice(0, 200);
    const firstRender = renderedFeedIds.size === 0;
    $('feed').innerHTML = list.length
      ? list.map((e) => {
        const isNew = animate && !firstRender && !renderedFeedIds.has(e.id);
        const cls = ['ev', e.baseline ? 'baseline' : '', isNew ? 'enter' : '', e.id === selectedEventId ? 'selected' : ''].filter(Boolean).join(' ');
        return `
        <div class="${cls}" data-ev="${esc(e.id)}">
          <span class="bar" style="background:${SEV_COLOR[e.severity]}"></span>
          <div class="body">
            <div class="title">${esc(e.title)}</div>
            <div class="meta">${fmtTime(e.ts)} &middot; ${esc(e.ruleName)}${e.zone ? `<span class="tag">${esc(e.zone)}</span>` : ''}${e.baseline ? '<span class="tag">baseline</span>' : ''}</div>
          </div>
        </div>`;
      }).join('')
      : '<div class="empty">No events yet. Rule matches appear here as sources poll.</div>';
    renderedFeedIds.clear();
    list.forEach((e) => renderedFeedIds.add(e.id));
    if (firstRender && !list.length) renderedFeedIds.add('__init__');

    const badge = $('unread');
    badge.textContent = unread;
    badge.classList.toggle('zero', unread === 0);
    if (unread > lastUnread) {
      badge.classList.add('bump');
      setTimeout(() => badge.classList.remove('bump'), 220);
    }
    lastUnread = unread;
  }

  $('feed').addEventListener('click', (e) => {
    const row = e.target.closest('[data-ev]');
    if (!row) return;
    const ev = events.find((x) => x.id === row.dataset.ev);
    if (ev) showEventDetail(ev);
    if (unread) {
      unread = 0;
      renderFeed({ animate: false });
    }
  });
  $('feedTitle').addEventListener('click', () => { unread = 0; renderFeed({ animate: false }); });
  $('sevFilter').addEventListener('change', () => renderFeed({ animate: false }));
  $('hideBaseline').addEventListener('change', () => renderFeed({ animate: false }));

  $('btnClear').addEventListener('click', () => {
    events = [];
    unread = 0;
    store.set('events', events);
    closeDetail();
    renderFeed({ animate: false });
    updateAlertLayer();
    updateRuleCounts();
  });

  $('btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `global-monitor-events-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('btnNotify').addEventListener('click', async () => {
    const btn = $('btnNotify');
    if (notifyEnabled) {
      notifyEnabled = false;
    } else if (!('Notification' in window)) {
      toast({ severity: 'medium', title: 'Browser notifications are not supported here.' });
      return;
    } else {
      try {
        const perm = await Notification.requestPermission();
        notifyEnabled = perm === 'granted';
        if (!notifyEnabled) toast({ severity: 'medium', title: 'Notification permission was not granted.' });
      } catch {
        toast({ severity: 'medium', title: 'Notifications are blocked in this context.' });
      }
    }
    btn.textContent = notifyEnabled ? 'Notify on' : 'Notify off';
    btn.classList.toggle('on', notifyEnabled);
  });

  /* ===================== UI: sources ===================== */

  let sourcesBuilt = false;

  function buildSources() {
    const rows = Object.entries(LAYERS).map(([key, l]) => `
        <div class="src" data-src="${key}">
          <label class="src-head">
            <input type="checkbox" data-layer="${key}" ${l.visible ? 'checked' : ''}>
            <span class="sw-ic" style="--c:${l.color};--m:url(${ATLAS.urls[LAYER_ICON[key]]})"></span>
            <span class="src-name">${esc(l.label)}<span class="src-sub">${esc(l.source)}</span></span>
            <span class="pill" data-f="pill"></span>
            <span class="count" data-f="count">0</span>
          </label>
          <div class="src-meta" data-f="meta"></div>
          <div class="src-err" data-f="err" hidden></div>
        </div>`).join('');
    const na = UNAVAILABLE_SOURCES.map((u) => `
        <div class="src na">
          <div class="src-head"><input type="checkbox" disabled><span class="sw" style="background:#5b6372;color:transparent"></span><span class="src-name">${esc(u.label)}</span><span class="pill">n/a</span></div>
          <div class="src-meta">${esc(u.why)}</div>
        </div>`).join('');
    $('sourcesList').innerHTML = `
      <div class="section-label">Live layers</div><div class="group">${rows}</div>
      <div class="section-label">Not available client-side</div><div class="group">${na}</div>
      <div class="note">Failed sources retry with exponential backoff (max 10 min). White satellites are above the observer's horizon right now.</div>`;
    sourcesBuilt = true;
  }

  function renderSources() {
    if (!sourcesBuilt) buildSources();
    for (const key of Object.keys(LAYERS)) {
      const row = document.querySelector(`[data-src="${key}"]`);
      if (!row) continue;
      const h = health[key];
      const f = (name) => row.querySelector(`[data-f="${name}"]`);
      const pill = f('pill');
      const pillText = h.status === 'off' ? 'setup' : h.status;
      if (pill.textContent !== pillText) {
        pill.textContent = pillText;
        pill.className = `pill ${h.status}`;
      }
      const count = data[key].length.toLocaleString();
      if (f('count').textContent !== count) f('count').textContent = count;
      const nextIn = h.nextAt ? Math.max(0, Math.round((h.nextAt - Date.now()) / 1000)) : null;
      f('meta').textContent = `Updated ${relTime(h.lastOk)} \u00b7 ${h.latencyMs != null ? `${h.latencyMs} ms` : '-'} \u00b7 next ${nextIn != null ? `${nextIn}s` : '-'}${h.failures ? ` \u00b7 ${h.failures} failed` : ''}`;
      const err = f('err');
      err.hidden = !h.error;
      if (h.error && err.textContent !== h.error) err.textContent = h.error;
    }
  }

  function renderKeyBox() {
    const hasKey = Boolean(store.get('windyKey', ''));
    const backendUrl = store.get('backendUrl', '');
    const auto = autoBackendUrl();
    $('keyBox').innerHTML = `
      <div class="keybox">
        <div class="src-name">Poller data URL</div>
        <div class="src-meta" style="margin-left:0">${auto
          ? 'Detected automatically from this GitHub Pages site. Override only if the data lives elsewhere.'
          : "Folder containing latest.json from the Monitor workflow's <b>data</b> branch. Must be https and publicly readable."}</div>
        <div class="field"><input type="url" id="backendUrlInput" placeholder="${esc(auto || 'https://...')}" value="${esc(backendUrl)}" autocomplete="off" spellcheck="false">
          <button class="btn" id="backendUrlSave">Save</button></div>
      </div>`;
    $('keyBox').insertAdjacentHTML('beforeend', `
      <div class="keybox">
        <div class="src-name">Windy Webcams API key</div>
        <div class="src-meta" style="margin-left:0">Free key from api.windy.com/keys. Stored only in this browser. Visible to anyone with access to this browser profile.</div>
        <div class="field"><input type="password" id="windyKeyInput" placeholder="${hasKey ? 'key saved' : 'paste key'}" autocomplete="off">
          <button class="btn" id="windyKeySave">Save</button>${hasKey ? '<button class="btn" id="windyKeyClear">Clear</button>' : ''}</div>
      </div>`);
  }

  $('keyBox').addEventListener('click', (e) => {
    if (e.target.id === 'backendUrlSave') {
      const value = $('backendUrlInput').value.trim();
      if (value) {
        let ok = false;
        try {
          const u = new URL(value);
          ok = u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1';
        } catch { /* invalid URL */ }
        if (!ok) {
          toast({ severity: 'medium', title: 'Poller data URL must be a valid https URL.' });
          return;
        }
      }
      store.set('backendUrl', value);
      renderKeyBox();
      runSource('alerts');
      return;
    }
    if (e.target.id === 'windyKeySave') {
      const value = $('windyKeyInput').value.trim();
      if (!value) return;
      store.set('windyKey', value);
      renderKeyBox();
      runSource('webcams');
    } else if (e.target.id === 'windyKeyClear') {
      store.set('windyKey', '');
      data.webcams = [];
      updateLayer('webcams');
      renderKeyBox();
    }
  });

  $('tab-sources').addEventListener('change', (e) => {
    const key = e.target.dataset.layer;
    if (!key) return;
    setLayerVisible(key, e.target.checked);
  });

  /* ===================== UI: rules ===================== */

  const ruleFireCount = (id) => events.filter((e) => e.ruleId === id).length;

  function updateRuleCounts() {
    document.querySelectorAll('[data-count]').forEach((el) => {
      el.textContent = `${ruleFireCount(el.dataset.count)} fired`;
    });
  }

  function renderRules() {
    const zoneOptions = (selected) => zones.map((z) =>
      `<option value="${esc(z.id)}"${z.id === selected ? ' selected' : ''}>${esc(z.name)}</option>`).join('');

    const cards = RULE_DEFS.map((def) => {
      const c = ruleCfg[def.id];
      const params = def.params.map((p) => {
        const v = c.params[p.key];
        let input;
        if (p.type === 'select') {
          input = `<select data-param="${def.id}:${p.key}">${p.options.map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
        } else if (p.type === 'zone') {
          input = `<select data-param="${def.id}:${p.key}">${zoneOptions(v)}</select>`;
        } else {
          input = `<input type="${p.type}"${p.step ? ` step="${p.step}"` : ''} value="${esc(v)}" data-param="${def.id}:${p.key}">`;
        }
        return `<div class="field"><span>${esc(p.label)}</span>${input}</div>`;
      }).join('');
      const scope = def.scopeLocked ? '' : `
        <div class="field"><span>Scope</span>
          <select data-scope="${def.id}">
            <option value="zones"${c.scope === 'zones' ? ' selected' : ''}>Watch zones</option>
            <option value="global"${c.scope === 'global' ? ' selected' : ''}>Global</option>
          </select>
        </div>`;
      return `
        <div class="rule${c.enabled ? '' : ' disabled'}">
          <label class="rule-head"><input type="checkbox" data-enable="${def.id}"${c.enabled ? ' checked' : ''}>${esc(def.name)}<span class="count" data-count="${def.id}">${ruleFireCount(def.id)} fired</span></label>
          <div class="rule-desc">${esc(def.description)} &middot; ${esc(LAYERS[def.layer].label)}</div>
          ${scope}${params}
        </div>`;
    }).join('');

    $('tab-rules').innerHTML =
      '<div class="note">Rules run on every poll. A new or edited rule first records existing matches as <b>baseline</b> (logged, no alert) so only genuinely new events notify you. Matches are de-duplicated for 3 days.</div>' + cards;
  }

  $('tab-rules').addEventListener('change', (e) => {
    const t = e.target;
    let id;
    if (t.dataset.enable) {
      id = t.dataset.enable;
      ruleCfg[id].enabled = t.checked;
    } else if (t.dataset.scope) {
      id = t.dataset.scope;
      ruleCfg[id].scope = t.value;
    } else if (t.dataset.param) {
      const [ruleId, key] = t.dataset.param.split(':');
      id = ruleId;
      const p = RULE_DEFS.find((d) => d.id === ruleId).params.find((x) => x.key === key);
      ruleCfg[ruleId].params[key] = p.type === 'number' ? Number(t.value) : t.value;
      if (key === 'observerZone') transitionState.delete(ruleId);
    } else {
      return;
    }
    ruleInit[id] = false;
    store.set('rules', ruleCfg);
    store.set('ruleInit', ruleInit);
    renderRules();
    reevaluateAll();
  });

  /* ===================== UI: zones ===================== */

  function resetZoneScopedRules() {
    for (const def of RULE_DEFS) {
      if (ruleCfg[def.id].scope === 'zones') ruleInit[def.id] = false;
    }
    store.set('ruleInit', ruleInit);
  }

  function saveZones() {
    store.set('zones', zones);
    updateZoneLines();
    resetZoneScopedRules();
    renderZones();
    renderRules();
    reevaluateAll();
  }

  function renderZones() {
    const list = zones.map((z) => `
      <div class="zone">
        <input type="checkbox" data-zone-enable="${esc(z.id)}"${z.enabled ? ' checked' : ''}>
        <div class="grow"><div>${esc(z.name)}</div><div class="meta">${z.lat.toFixed(2)}, ${z.lng.toFixed(2)} &middot; r ${z.radiusKm} km</div></div>
        <button class="btn" data-zone-fly="${esc(z.id)}">View</button>
        <button class="btn" data-zone-del="${esc(z.id)}">Del</button>
      </div>`).join('');
    $('tab-zones').innerHTML = `
      <div class="note">Zone-scoped rules fire only for items within an enabled zone (great-circle distance from centre).</div>
      ${list ? `<div class="group">${list}</div>` : '<div class="empty">No zones defined.</div>'}
      <form class="zone-form" id="zoneForm" autocomplete="off">
        <input class="full" name="name" placeholder="Zone name" required maxlength="40">
        <input name="lat" type="number" step="any" min="-90" max="90" placeholder="Latitude" required>
        <input name="lng" type="number" step="any" min="-180" max="180" placeholder="Longitude" required>
        <input name="radius" type="number" min="10" max="6000" placeholder="Radius km" required>
        <button type="button" class="btn${pickMode ? ' on' : ''}" id="pickBtn">${pickMode ? 'Click globe' : 'Pick on globe'}</button>
        <button type="submit" class="btn full">Add zone</button>
      </form>`;
  }

  function setPickMode(on) {
    pickMode = on;
    canvas.classList.toggle('picking', on);
    const btn = $('pickBtn');
    if (btn) {
      btn.textContent = on ? 'Click globe' : 'Pick on globe';
      btn.classList.toggle('on', on);
    }
  }

  $('tab-zones').addEventListener('change', (e) => {
    const id = e.target.dataset.zoneEnable;
    if (!id) return;
    const z = zones.find((x) => x.id === id);
    if (z) { z.enabled = e.target.checked; saveZones(); }
  });

  $('tab-zones').addEventListener('click', (e) => {
    const t = e.target;
    if (t.id === 'pickBtn') { setPickMode(!pickMode); return; }
    if (t.dataset.zoneFly) {
      const z = zones.find((x) => x.id === t.dataset.zoneFly);
      if (z) flyTo(z.lat, z.lng);
      return;
    }
    if (t.dataset.zoneDel) {
      zones = zones.filter((x) => x.id !== t.dataset.zoneDel);
      if (ruleCfg.sat_pass.params.observerZone === t.dataset.zoneDel && zones[0]) {
        ruleCfg.sat_pass.params.observerZone = zones[0].id;
        store.set('rules', ruleCfg);
      }
      saveZones();
    }
  });

  $('tab-zones').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const zone = {
      id: `z-${Date.now().toString(36)}`, name: f.name.value.trim(),
      lat: Number(f.lat.value), lng: Number(f.lng.value), radiusKm: Number(f.radius.value), enabled: true
    };
    if (!zone.name || !Number.isFinite(zone.lat) || !Number.isFinite(zone.lng) || !(zone.radiusKm > 0)) return;
    zones.push(zone);
    saveZones();
    flyTo(zone.lat, zone.lng);
  });

  /* ===================== Tabs, panels, clock ===================== */

  const TAB_ORDER = ['sources', 'rules', 'zones'];
  let activeTab = 'sources';

  $('tabs').addEventListener('click', (e) => {
    const tab = e.target.dataset.tab;
    if (!tab || tab === activeTab) return;
    const forward = TAB_ORDER.indexOf(tab) > TAB_ORDER.indexOf(activeTab);
    const prev = $(`tab-${activeTab}`);
    prev.classList.toggle('leaving-left', forward);
    prev.classList.remove('active');
    const next = $(`tab-${tab}`);
    next.style.transition = 'none';
    next.classList.toggle('leaving-left', !forward);
    void next.offsetWidth;
    next.style.transition = '';
    next.classList.remove('leaving-left');
    next.classList.add('active');
    activeTab = tab;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('tabIndicator').style.transform = `translateX(${TAB_ORDER.indexOf(tab) * 100}%)`;
    if (tab === 'sources') renderSources();
  });

  const isCompact = () => window.matchMedia('(max-width: 900px)').matches;

  function syncSheetState() {
    document.body.classList.toggle('sheet-open', $('left').classList.contains('open') || $('right').classList.contains('open'));
  }
  function openPanel(side, full = false) {
    if (!isCompact()) return;
    $(side === 'left' ? 'right' : 'left').classList.remove('open', 'full');
    $(side).classList.add('open');
    $(side).classList.toggle('full', full);
    syncSheetState();
    tagsDirty = true;
  }
  function closePanels() {
    for (const id of ['left', 'right']) $(id).classList.remove('open', 'full');
    syncSheetState();
    tagsDirty = true;
  }
  $('toggleLeft').addEventListener('click', () => openPanel('left'));
  $('toggleRight').addEventListener('click', () => openPanel('right'));

  /* Bottom sheets on phones: drag the grabber or header to snap between half, full and closed. */
  for (const id of ['left', 'right']) {
    const sheet = $(id);
    let drag = null;
    let suppressClick = false;
    const start = (e) => {
      if (!isCompact() || !sheet.classList.contains('open')) return;
      if (e.target.closest('button:not(.grabber), input, select, a, label')) return;
      const vh = window.innerHeight;
      const base = sheet.classList.contains('full') ? 0 : 0.36 * vh;
      drag = { y0: e.clientY, base, t0: performance.now(), lastY: e.clientY, lastT: performance.now(), moved: false };
      sheet.classList.add('dragging');
      e.currentTarget.setPointerCapture(e.pointerId);
    };
    const move = (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y0;
      if (Math.abs(dy) > 4) drag.moved = true;
      drag.vy = (e.clientY - drag.lastY) / Math.max(1, performance.now() - drag.lastT);
      drag.lastY = e.clientY;
      drag.lastT = performance.now();
      sheet.style.transform = `translateY(${Math.max(0, drag.base + dy)}px)`;
    };
    const end = (e) => {
      if (!drag) return;
      const vh = window.innerHeight;
      const y = Math.max(0, drag.base + (e.clientY - drag.y0));
      const projected = y + (drag.vy || 0) * 180;
      sheet.classList.remove('dragging');
      sheet.style.transform = '';
      if (drag.moved) {
        suppressClick = true;
        if (projected > 0.66 * vh) closePanels();
        else if (projected < 0.18 * vh) openPanel(id, true);
        else openPanel(id, false);
      }
      drag = null;
    };
    for (const handle of sheet.querySelectorAll('.grabber, .panel-head')) {
      handle.addEventListener('pointerdown', start);
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    }
    sheet.querySelector('.grabber').addEventListener('click', () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (sheet.classList.contains('full')) openPanel(id, false);
      else closePanels();
    });
  }

  /* ----- Layer chips ----- */
  const CHIP_LABEL = { flights: 'Flights', quakes: 'Quakes', gdacs: 'GDACS', eonet: 'Events', satellites: 'Satellites', webcams: 'Cams', alerts: 'India' };

  function buildChips() {
    $('chips').innerHTML = Object.keys(LAYERS).map((key) => `
      <button class="chip${LAYERS[key].visible ? '' : ' off'}" type="button" data-chip="${key}" aria-pressed="${LAYERS[key].visible}">
        <span class="ic" style="--c:${LAYERS[key].color};--m:url(${ATLAS.urls[LAYER_ICON[key]]})"></span>${CHIP_LABEL[key]}<span class="n" data-n="${key}"></span>
      </button>`).join('');
  }
  function syncChips() {
    for (const key of Object.keys(LAYERS)) {
      const chip = document.querySelector(`[data-chip="${key}"]`);
      if (!chip) continue;
      chip.classList.toggle('off', !LAYERS[key].visible);
      chip.setAttribute('aria-pressed', String(LAYERS[key].visible));
      const n = data[key].length;
      const label = n ? (n > 999 ? `${(n / 1000).toFixed(1)}k` : String(n)) : '';
      const el = chip.querySelector('[data-n]');
      if (el.textContent !== label) el.textContent = label;
    }
  }
  $('chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-chip]');
    if (!chip) return;
    const key = chip.dataset.chip;
    setLayerVisible(key, !LAYERS[key].visible);
    const box = document.querySelector(`[data-layer="${key}"]`);
    if (box) box.checked = LAYERS[key].visible;
    tagsDirty = true;
    syncChips();
  });

  /* ----- Status pill ----- */
  function updateStatus() {
    const keys = Object.keys(LAYERS);
    const configured = keys.filter((k) => health[k].status !== 'off');
    const failing = configured.filter((k) => health[k].status === 'error');
    const stale = configured.filter((k) => health[k].status === 'stale');
    const live = configured.length - failing.length - stale.length;
    const alertsNow = alertItems.length;
    $('statusText').textContent = `${alertsNow ? `${alertsNow} alert${alertsNow === 1 ? '' : 's'}` : 'No new alerts'} \u00b7 ${live}/${configured.length} live`;
    const led = $('statusLed');
    led.classList.toggle('bad', failing.length > configured.length / 2);
    led.classList.toggle('warn', !(failing.length > configured.length / 2) && (failing.length + stale.length) > 0);
  }
  $('statusPill').addEventListener('click', () => {
    if (isCompact()) openPanel('right');
    else $('feed').scrollTo({ top: 0, behavior: 'smooth' });
  });

  /* ----- Search ----- */
  const SEARCH_FIELDS = {
    flights: (it) => [it.callsign, it.id, it.country],
    satellites: (it) => [it.name, it.id],
    quakes: (it) => [it.place, `M${(it.mag || 0).toFixed(1)}`],
    gdacs: (it) => [it.name, it.country, it.type],
    eonet: (it) => [it.title, it.category],
    webcams: (it) => [it.title, it.city],
    alerts: (it) => [it.title, ...(it.districts || [])]
  };
  let searchHits = [];
  let searchActive = 0;

  function runSearch(q) {
    const term = q.trim().toLowerCase();
    if (term.length < 2) return [];
    const hits = [];
    for (const key of Object.keys(LAYERS)) {
      const fields = SEARCH_FIELDS[key];
      for (const it of data[key]) {
        const texts = fields(it).filter(Boolean).map((t) => String(t).toLowerCase());
        const exact = texts.some((t) => t === term);
        const prefix = texts.some((t) => t.startsWith(term));
        const any = prefix || texts.some((t) => t.includes(term));
        if (!any) continue;
        hits.push({ key, it, score: exact ? 3 : prefix ? 2 : 1 });
        if (hits.length > 400) break;
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, 8);
  }

  function renderSearch() {
    const box = $('searchResults');
    const q = $('search').value;
    if (q.trim().length < 2) {
      box.hidden = true;
      return;
    }
    searchHits = runSearch(q);
    searchActive = 0;
    box.innerHTML = searchHits.length
      ? searchHits.map((h, n) => `
        <button type="button" data-hit="${n}" class="${n === 0 ? 'active' : ''}">
          <span class="ic" style="--c:${LAYERS[h.key].color};--m:url(${ATLAS.urls[iconFor(h.key, h.it).icon]})"></span>
          <span class="lbl">${esc(tagText(h.key, h.it) || h.it.title || h.it.name || h.it.id)}</span>
          <span class="kind">${esc(CHIP_LABEL[h.key])}</span>
        </button>`).join('')
      : '<div class="none">No matches in the loaded layers.</div>';
    box.hidden = false;
  }

  function chooseHit(n) {
    const h = searchHits[n];
    if (!h) return;
    if (!LAYERS[h.key].visible) {
      setLayerVisible(h.key, true);
      syncChips();
    }
    flyTo(h.it.lat, h.it.lng, 190);
    showItemDetail(h.key, h.it);
    $('search').value = '';
    $('searchResults').hidden = true;
    $('search').blur();
  }

  let searchTimer = null;
  $('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderSearch, 120);
  });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('search').value = '';
      $('searchResults').hidden = true;
      $('search').blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      chooseHit(searchActive);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!searchHits.length) return;
      searchActive = (searchActive + (e.key === 'ArrowDown' ? 1 : -1) + searchHits.length) % searchHits.length;
      document.querySelectorAll('#searchResults button').forEach((b, n) => b.classList.toggle('active', n === searchActive));
    }
  });
  $('searchResults').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hit]');
    if (b) chooseHit(Number(b.dataset.hit));
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.search')) $('searchResults').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement === document.body) {
      e.preventDefault();
      $('search').focus();
    }
  });

  setInterval(() => {
    const now = new Date();
    $('clock').innerHTML = `${now.toLocaleTimeString([], { hour12: false })}<br>${now.toISOString().slice(11, 16)} UTC`;
    if (activeTab === 'sources') renderSources();
    updateStatus();
    syncChips();
  }, 1000);

  /* ===================== Scheduler ===================== */

  function schedule(key, delayMs) {
    health[key].nextAt = Date.now() + delayMs;
    setTimeout(() => runSource(key), delayMs);
  }

  async function runSource(key) {
    const h = health[key];
    if (h.status === 'idle') h.status = 'loading';
    const t0 = performance.now();
    const interval = DEMO ? DEMO_INTERVALS[key] : key === 'flights' && backendBase() ? 5 * 60 * 1000 : LAYERS[key].intervalMs;
    try {
      const items = await (DEMO ? DEMO_FETCHERS : FETCHERS)[key]();
      h.latencyMs = Math.round(performance.now() - t0);
      h.lastOk = Date.now();
      h.failures = 0;
      h.error = null;
      h.status = items.warning ? 'stale' : 'live';
      if (items.warning) h.error = items.warning;
      data[key] = items;
      updateLayer(key);
      if (key === 'alerts') updateAlertPolygons(items);
      evaluate(key, items);
      schedule(key, interval);
    } catch (err) {
      /* A source waiting for a key or URL is not broken: show it as needing setup, without backoff. */
      if (/no API key|no poller data URL/.test(err.message)) {
        h.status = 'off';
        h.error = err.message;
        h.failures = 0;
        schedule(key, Math.max(interval, 60000));
        return;
      }
      h.failures++;
      h.status = 'error';
      h.error = err.message;
      schedule(key, Math.min(interval * 2 ** h.failures, 600000));
    }
  }

  /* Flights from a snapshot move along their tracks every 5 s between refreshes. */
  setInterval(() => {
    if (DEMO || !flightSnapshot) return;
    data.flights = projectFlights();
    updateLayer('flights');
  }, 5000);

  /* Satellites are re-propagated at 10 Hz so they glide instead of jumping; rules still run every 2 s. */
  let satTick = 0;
  setInterval(() => {
    let items;
    if (DEMO) {
      items = demoSatellites();
    } else {
      if (!satLibOk || !satCatalog.length) return;
      items = propagateSatellites();
    }
    data.satellites = items;
    updateLayer('satellites');
    if (++satTick % 20 === 0) evaluate('satellites', items);
  }, 100);

  /* ===================== Boot ===================== */

  globeGroup.rotation.y = Math.PI / 2 - (80 + 180) * DEG;
  globeGroup.rotation.x = 18 * DEG;

  $('modeBtn').textContent = DEMO ? 'Live' : 'Demo';
  $('modeBtn').title = DEMO ? 'Switch to live data' : 'Load synthetic demo data';
  $('modeBtn').addEventListener('click', () => {
    const url = new URL(location.href);
    url.hash = DEMO ? '' : 'demo';
    url.searchParams.delete('demo');
    location.replace(url.toString());
    location.reload();
  });
  if (DEMO) {
    $('demoPill').hidden = false;
    setTimeout(() => toast({ severity: 'medium', title: 'Demo mode: synthetic data, not real events.' }), 900);
  }

  updateZoneLines();
  updateAlertLayer();
  renderSources();
  buildChips();
  syncChips();
  const setSearchPlaceholder = () => { $('search').placeholder = isCompact() ? 'Search' : 'Search flight, satellite, district'; };
  setSearchPlaceholder();
  window.addEventListener('resize', setSearchPlaceholder);
  updateStatus();
  if (DEMO) {
    $('keyBox').innerHTML = '<div class="note">Demo mode: webcam points are synthetic and carry no images. Switch to live and add a Windy key for real feeds.</div>';
  } else {
    renderKeyBox();
  }
  renderRules();
  renderZones();
  renderFeed();
  requestAnimationFrame(animate);
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('booted')));

  loadWorld().catch((err) => toast({ severity: 'medium', title: `Country outlines unavailable (${err.message}).` }));
  Object.keys(LAYERS).forEach((key, i) => setTimeout(() => runSource(key), 300 + i * 350));
})();
