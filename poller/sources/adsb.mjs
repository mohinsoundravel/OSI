/**
 * Regional aircraft from adsb.lol (community ADS-B receivers, ODbL, no key), every poll.
 *
 * The global OpenSky snapshot is refreshed only every 25 minutes (API credits), which is
 * too old to say which aircraft is above you. adsb.lol's point query (radius up to 250
 * nautical miles) covers Tamil Nadu, Kerala and Puducherry in one request, so aircraft
 * there are at most one poll old. Browsers cannot call adsb.lol directly (no CORS), so
 * the rows are merged into the published flight snapshot.
 */

const BASE = 'https://api.adsb.lol/v2/point';
const FT_TO_M = 0.3048;
const KT_TO_MS = 0.514444;
const FPM_TO_MS = 0.00508;
const r = (v, d) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** adsb.lol aircraft -> rows in the order of FLIGHT_FIELDS (positionTime in Unix seconds). */
export function adsbRows(json, nowS) {
  const list = Array.isArray(json?.ac) ? json.ac : [];
  const out = [];
  for (const a of list.slice(0, 5000)) {
    const lat = Number(a.lat);
    const lng = Number(a.lon);
    const hex = String(a.hex || '').replace(/^~/, '').toLowerCase();
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !/^[0-9a-f]{6}$/.test(hex)) continue;
    const onGround = a.alt_baro === 'ground';
    const altFt = onGround ? 0 : Number(a.alt_baro ?? a.alt_geom);
    const seen = Number.isFinite(a.seen_pos) ? a.seen_pos : Number.isFinite(a.seen) ? a.seen : 0;
    out.push([
      hex,
      String(a.flight || a.r || '').trim().slice(0, 10),
      '',
      r(lat, 3), r(lng, 3),
      Number.isFinite(altFt) ? Math.round(altFt * FT_TO_M) : null,
      onGround ? 1 : 0,
      Number.isFinite(a.gs) ? r(a.gs * KT_TO_MS, 1) : null,
      Number.isFinite(a.track) ? Math.round(a.track) : null,
      Number.isFinite(a.baro_rate) ? r(a.baro_rate * FPM_TO_MS, 1) : null,
      typeof a.squawk === 'string' ? a.squawk.slice(0, 4) : null,
      Math.round(nowS - Math.max(0, seen))
    ]);
  }
  return out;
}

export async function fetchRegionalAircraft({ http, center, radiusNm = 250, now = Date.now() }) {
  const nm = Math.max(1, Math.min(250, Math.round(radiusNm)));
  const { json } = await http.getJson(`${BASE}/${center.lat}/${center.lng}/${nm}`, { timeoutMs: 30000 });
  const nowS = Number.isFinite(json?.now) ? json.now / 1000 : now / 1000;
  return { rows: adsbRows(json, nowS), time: Math.round(nowS), center, radiusNm: nm };
}

/**
 * Regional rows replace the global snapshot's rows for the same aircraft when newer, and
 * add aircraft the snapshot lacks. Returns the merged rows.
 */
export function mergeAircraft(globalRows, regionalRows) {
  const byId = new Map(globalRows.map((row) => [row[0], row]));
  for (const row of regionalRows) {
    const prev = byId.get(row[0]);
    if (!prev) {
      byId.set(row[0], row);
    } else if ((row[11] ?? 0) >= (prev[11] ?? 0)) {
      /* Keep the global row's country (adsb.lol has none). */
      byId.set(row[0], [...row.slice(0, 2), prev[2] || row[2], ...row.slice(3)]);
    }
  }
  return [...byId.values()];
}
