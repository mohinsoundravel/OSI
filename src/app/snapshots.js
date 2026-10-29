/** Flight and ship snapshots from the poller, dead-reckoned between refreshes. */
import { appState } from './app-state.js';
import { SEV_COLOR, destination, hexToRgb, relTime } from './core.js';
import { str } from './layers.js';
import { flightColor } from './fetchers.js';

/* ----- Flight snapshot from the poller, projected forward between refreshes (dead reckoning) ----- */
const FLIGHT_STALE_MS = 50 * 60 * 1000;
const MAX_PROJECTION_S = 45 * 60;

export function parseFlightSnapshot(snap) {
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

export function projectFlights() {
  if (!appState.flightSnapshot) return [];
  const nowS = Date.now() / 1000;
  const items = appState.flightSnapshot.rows.map((f) => {
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
  const age = Date.now() - appState.flightSnapshot.fetchedAt;
  if (age > FLIGHT_STALE_MS) items.warning = `stale: flight snapshot ${relTime(appState.flightSnapshot.fetchedAt)}`;
  return items;
}

/* ----- Ship snapshot (AIS via the poller), dead-reckoned like flights ----- */
const SHIP_STALE_MS = 50 * 60 * 1000;
const SHIP_MAX_PROJECTION_S = 30 * 60;
export const AIS_STATUS = {
  0: 'Under way (engine)', 1: 'At anchor', 2: 'Not under command', 3: 'Restricted manoeuvrability', 4: 'Constrained by draught',
  5: 'Moored', 6: 'Aground', 7: 'Fishing', 8: 'Under way (sailing)', 14: 'AIS-SART (search and rescue)'
};
export function shipTypeLabel(t) {
  if (!Number.isFinite(t)) return 'Unknown';
  if (t === 30) return 'Fishing';
  if (t === 31 || t === 32 || t === 52) return 'Tug';
  if (t === 35) return 'Military';
  if (t === 36 || t === 37) return 'Sailing / pleasure';
  if (t === 51) return 'Search and rescue';
  if (t === 50 || t === 53 || t === 54 || t === 55 || t === 58) return 'Port / special craft';
  if (t >= 60 && t <= 69) return 'Passenger';
  if (t >= 70 && t <= 79) return 'Cargo';
  if (t >= 80 && t <= 89) return 'Tanker';
  if (t >= 40 && t <= 49) return 'High-speed craft';
  return 'Other';
}
function shipColor(t, status) {
  if (status === 6 || status === 2 || status === 14) return hexToRgb(SEV_COLOR.high);
  if (t >= 80 && t <= 89) return hexToRgb('#ff7a6b');
  if (t >= 70 && t <= 79) return hexToRgb('#6fd08c');
  if (t >= 60 && t <= 69) return hexToRgb('#5ac8fa');
  if (t === 30) return hexToRgb('#f5b14c');
  if (t === 35 || t === 51) return hexToRgb('#d7a6ff');
  return hexToRgb('#b8c2cc');
}

export function parseShipSnapshot(snap) {
  if (!snap || !Array.isArray(snap.fields) || !Array.isArray(snap.ships)) throw new Error('unexpected ships.json format');
  const col = Object.fromEntries(snap.fields.map((f, i) => [f, i]));
  for (const need of ['mmsi', 'lat', 'lng']) if (!(need in col)) throw new Error(`ships.json missing ${need}`);
  const fin = (v) => (Number.isFinite(v) ? v : null);
  const rows = [];
  for (const row of snap.ships.slice(0, 20000)) {
    if (!Array.isArray(row)) continue;
    const lat = fin(row[col.lat]);
    const lng = fin(row[col.lng]);
    const mmsi = fin(row[col.mmsi]);
    if (lat === null || lng === null || mmsi === null) continue;
    rows.push({
      id: String(Math.trunc(mmsi)), name: str(row[col.name], 40), lat0: lat, lng0: lng,
      sog: fin(row[col.sog]), cog: fin(row[col.cog]), heading: fin(row[col.heading]), type: fin(row[col.type]),
      status: fin(row[col.status]), t0: fin(row[col.time]) || Date.parse(snap.fetchedAt) / 1000,
      destination: str(row[col.destination], 30), callsign: str(row[col.callsign], 12), lengthM: fin(row[col.lengthM])
    });
  }
  return { fetchedAt: Date.parse(snap.fetchedAt) || Date.now(), rows };
}

export function projectShips() {
  if (!appState.shipSnapshot) return [];
  const nowS = Date.now() / 1000;
  const items = appState.shipSnapshot.rows.map((s) => {
    const dt = Math.max(0, Math.min(SHIP_MAX_PROJECTION_S, nowS - s.t0));
    const moving = Number.isFinite(s.sog) && s.sog > 0.5 && Number.isFinite(s.cog);
    const p = moving ? destination(s.lat0, s.lng0, s.cog, s.sog * 1.852 * (dt / 3600)) : { lat: s.lat0, lng: s.lng0 };
    return {
      ...s, lat: p.lat, lng: p.lng, altKm: 0, reportedAt: s.t0 * 1000, projected: moving && dt > 60,
      moving, color: shipColor(s.type, s.status)
    };
  });
  if (Date.now() - appState.shipSnapshot.fetchedAt > SHIP_STALE_MS) items.warning = `stale: ship snapshot ${relTime(appState.shipSnapshot.fetchedAt)}`;
  return items;
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  appState.flightSnapshot = null;
  appState.shipSnapshot = null;
}
