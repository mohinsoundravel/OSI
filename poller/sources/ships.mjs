/**
 * Ship positions (AIS) from AISStream.io, republished for the dashboard.
 *
 * AISStream is a WebSocket stream that needs an API key, so a browser on a public
 * page cannot use it without exposing the key. The poller listens for a short
 * window each run inside a bounding box around India, merges what it hears with
 * earlier runs (ships report every few seconds when moving, every few minutes at
 * anchor), and publishes ships.json. The dashboard dead-reckons between snapshots.
 *
 * Limits: AISStream relies on volunteer coastal receivers, so open-ocean and
 * thinly covered coasts show few ships; there is no satellite AIS.
 */
import { connectWebSocket } from '../lib/ws.mjs';

export const AIS_URL = 'wss://stream.aisstream.io/v0/stream';
/* [[lat, lon], [lat, lon]]: Arabian Sea, Bay of Bengal and the waters off Sri Lanka. */
export const AIS_BBOX = [[[0, 60], [26, 100]]];
export const SHIP_FIELDS = ['mmsi', 'name', 'lat', 'lng', 'sog', 'cog', 'heading', 'type', 'status', 'time', 'destination', 'callsign', 'lengthM'];
const SHIP_KEEP_MS = 3 * 3600 * 1000;
const MAX_SHIPS = 8000;
const MAX_STATIC = 15000;

const str = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f@]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '');
const fin = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/** Parses one AISStream message into a position and/or static update. */
export function parseAisMessage(text) {
  let m;
  try { m = JSON.parse(text); } catch { return null; }
  if (!m || typeof m !== 'object' || m.error) return m && m.error ? { error: str(String(m.error), 200) } : null;
  const meta = m.MetaData || {};
  const mmsi = Number(meta.MMSI);
  if (!Number.isInteger(mmsi) || mmsi < 100000000 || mmsi > 999999999) return null;
  const time = Date.parse(String(meta.time_utc || '').replace(/ \+0000 UTC$/, 'Z').replace(' ', 'T')) || null;
  const body = m.Message || {};
  const out = { mmsi, name: str(meta.ShipName, 40) };
  const pos = body.PositionReport || body.StandardClassBPositionReport || body.ExtendedClassBPositionReport;
  if (pos && pos.Valid !== false) {
    const lat = fin(pos.Latitude, -90, 90);
    const lng = fin(pos.Longitude, -180, 180);
    if (lat !== null && lng !== null && !(lat === 0 && lng === 0)) {
      out.position = {
        lat, lng,
        sog: fin(pos.Sog, 0, 102.2),
        cog: fin(pos.Cog, 0, 359.9),
        heading: fin(pos.TrueHeading, 0, 359),
        status: Number.isInteger(pos.NavigationalStatus) ? pos.NavigationalStatus : null,
        time: time || null
      };
    }
  }
  const st = body.ShipStaticData || (body.StaticDataReport && body.StaticDataReport.ReportB);
  if (st) {
    const d = st.Dimension || {};
    const length = Number(d.A) + Number(d.B);
    out.static = {
      name: str(st.Name || st.ShipName, 40) || out.name,
      type: Number.isInteger(st.Type) ? st.Type : Number.isInteger(st.ShipType) ? st.ShipType : null,
      destination: str(st.Destination, 30),
      callsign: str(st.CallSign, 12),
      lengthM: Number.isFinite(length) && length > 0 && length < 500 ? length : null
    };
  }
  return out.position || out.static ? out : null;
}

/** Listens for listenMs and returns { positions: Map, statics: Map, messages, errors }. */
export async function listenShips({ apiKey, listenMs = 45000, bbox = AIS_BBOX, connect = connectWebSocket, userAgent }) {
  if (!apiKey) throw new Error('AISSTREAM_API_KEY not set');
  const positions = new Map();
  const statics = new Map();
  let messages = 0;
  let serverError = null;
  let closeReason = null;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const ws = await connect(AIS_URL, {
    userAgent,
    onMessage: (text) => {
      messages++;
      const p = parseAisMessage(text);
      if (!p) return;
      if (p.error) { serverError = p.error; return; }
      if (p.position) {
        const prev = positions.get(p.mmsi);
        if (!prev || (p.position.time || 0) >= (prev.time || 0)) positions.set(p.mmsi, { ...p.position, name: p.name });
      }
      if (p.static) statics.set(p.mmsi, p.static);
    },
    onClose: (reason) => { closeReason = reason; resolveDone(); }
  });
  /* AISStream drops connections that do not subscribe within 3 seconds. */
  ws.send(JSON.stringify({ APIKey: apiKey, BoundingBoxes: bbox, FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'] }));
  const timer = setTimeout(() => ws.close(), listenMs);
  await done;
  clearTimeout(timer);
  if (serverError) throw new Error(`AISStream: ${serverError}`);
  if (!messages && closeReason !== 'closed by client') throw new Error(`AISStream closed early (${closeReason})`);
  return { positions, statics, messages };
}

/** Merges a listening window into the persisted state and returns the published rows. */
export function mergeShips(state, heard, now) {
  const ships = state.ships || {};
  const statics = state.shipStatic || {};
  for (const [mmsi, s] of heard.statics) statics[mmsi] = { ...s, seen: now };
  for (const [mmsi, p] of heard.positions) ships[mmsi] = { ...p, time: p.time || now };
  for (const [mmsi, p] of Object.entries(ships)) if (now - p.time > SHIP_KEEP_MS) delete ships[mmsi];
  for (const [mmsi, s] of Object.entries(statics)) if (now - s.seen > 7 * 86400000) delete statics[mmsi];
  const trim = (obj, max, ts) => {
    const keys = Object.keys(obj);
    if (keys.length <= max) return obj;
    keys.sort((a, b) => ts(obj[b]) - ts(obj[a]));
    return Object.fromEntries(keys.slice(0, max).map((k) => [k, obj[k]]));
  };
  state.ships = trim(ships, MAX_SHIPS, (p) => p.time);
  state.shipStatic = trim(statics, MAX_STATIC, (s) => s.seen);
  const rows = Object.entries(state.ships).map(([mmsi, p]) => {
    const st = state.shipStatic[mmsi] || {};
    return [Number(mmsi), st.name || p.name || '', p.lat, p.lng, p.sog, p.cog, p.heading, st.type ?? null, p.status, Math.round(p.time / 1000), st.destination || '', st.callsign || '', st.lengthM ?? null];
  });
  return rows;
}
