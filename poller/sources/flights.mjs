/**
 * Aircraft states from the OpenSky Network (anonymous API).
 *
 * OpenSky only allows its own website to read the API from a browser (CORS), so
 * the dashboard cannot fetch it directly when hosted elsewhere. The poller
 * fetches it server-side and publishes a compact snapshot; the dashboard
 * projects each aircraft forward along its track between snapshots.
 *
 * A global request costs 4 of the ~400 anonymous daily credits, so snapshots
 * are refreshed at most every MIN_INTERVAL_MS even though the poller runs every
 * 15 minutes.
 */

const STATES_URL = 'https://opensky-network.org/api/states/all';
export const FLIGHTS_MIN_INTERVAL_MS = 25 * 60 * 1000;

/* Columns of the published snapshot (one array per aircraft, to keep the file small). */
export const FLIGHT_FIELDS = ['icao24', 'callsign', 'country', 'lat', 'lng', 'baroAltM', 'onGround', 'velocity', 'track', 'verticalRate', 'squawk', 'positionTime'];

const r = (v, d) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/**
 * Returns null when the previous snapshot is still fresh enough (no request made),
 * otherwise { time, states } with states as compact arrays.
 */
export async function fetchFlights({ http, lastFetchedAt = 0, now = Date.now(), minIntervalMs = FLIGHTS_MIN_INTERVAL_MS }) {
  if (now - lastFetchedAt < minIntervalMs) return null;
  const { json } = await http.getJson(STATES_URL, { timeoutMs: 60000 });
  if (!json || !Array.isArray(json.states)) throw new Error('unexpected OpenSky response');
  const states = [];
  for (const s of json.states) {
    const lng = s[5];
    const lat = s[6];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    states.push([
      String(s[0] || '').slice(0, 8),
      String(s[1] || '').trim().slice(0, 10),
      String(s[2] || '').slice(0, 40),
      r(lat, 3), r(lng, 3),
      Number.isFinite(s[7]) ? Math.round(s[7]) : null,
      s[8] ? 1 : 0,
      r(s[9], 1),
      Number.isFinite(s[10]) ? Math.round(s[10]) : null,
      r(s[11], 1),
      s[14] ? String(s[14]).slice(0, 4) : null,
      Number.isFinite(s[3]) ? s[3] : Number.isFinite(s[4]) ? s[4] : json.time
    ]);
  }
  return { time: json.time, states };
}

/** Expands compact rows into objects for rule evaluation. */
export function expandFlights(snapshot) {
  if (!snapshot) return [];
  return snapshot.states.map((row) => Object.fromEntries(FLIGHT_FIELDS.map((f, i) => [f, row[i]])));
}
