/** Demo mode: synthetic, clearly labelled data for every layer. */
import { appState } from './app-state.js';
import { DEG, EARTH_KM, GDACS_COLOR, destination, haversineKm, hexToRgb } from './core.js';
import { liveStreamItems, normalizeBackend } from './layers.js';
import { projectShips } from './snapshots.js';
import { flightColor } from './fetchers.js';
import { observerZone } from './rules.js';

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

export const DEMO_INTERVALS = { flights: 10000, quakes: 15000, gdacs: 20000, eonet: 25000, satellites: 3600000, webcams: 30000, live: 3600000, ships: 30000, alerts: 20000 };
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

export function demoSatellites(at = Date.now()) {
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

export const DEMO_FETCHERS = {
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
  async live() {
    return liveStreamItems();
  },
  async ships() {
    /* Synthetic traffic on real lanes: Chennai, Ennore, Tuticorin, Kochi and the Palk Strait. */
    const lanes = [
      ['MV DEMO CHENNAI', 70, 13.1, 80.45, 95, 11], ['MT DEMO ENNORE', 80, 13.3, 80.5, 30, 9], ['MV DEMO TUTICORIN', 70, 8.7, 78.35, 150, 12],
      ['MV DEMO KOCHI', 70, 9.9, 76.1, 300, 13], ['FV DEMO RAMESWARAM', 30, 9.35, 79.4, 60, 5], ['MV DEMO PALK', 60, 9.6, 79.9, 10, 0]
    ];
    const t = Date.now() / 1000;
    appState.shipSnapshot = { fetchedAt: Date.now(), rows: lanes.map(([name, type, lat, lng, cog, sog], i) => ({
      id: String(419900100 + i), name: `${name} [DEMO]`, lat0: lat, lng0: lng, sog, cog, heading: cog, type,
      status: sog ? 0 : 1, t0: t - 120, destination: 'DEMO', callsign: '', lengthM: 120 + i * 15
    })) };
    return projectShips();
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
