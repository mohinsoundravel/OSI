/**
 * Sea state along the Tamil Nadu coast: Open-Meteo Marine (wave model forecasts), one
 * batched request for all coastal points, at most hourly.
 *
 * Categories follow the WMO sea-state code on significant wave height:
 * moderate 1.25-2.5 m, rough 2.5-4 m, very rough 4-6 m, high 6-9 m, very high 9+ m.
 * These are model forecasts for fishermen's safety and storm-surge context; official
 * high-wave alerts come from INCOIS through SACHET.
 */

export const MARINE_MIN_INTERVAL_MS = 60 * 60 * 1000;
const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';

export const SEA_STATES = [
  [9, 'Very high'], [6, 'High'], [4, 'Very rough'], [2.5, 'Rough'], [1.25, 'Moderate'], [0.5, 'Slight'], [0, 'Calm']
];
export const seaState = (m) => (Number.isFinite(m) ? (SEA_STATES.find(([min]) => m >= min) || SEA_STATES.at(-1))[1] : 'Unknown');

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

export async function fetchMarine({ http, points, lastFetchedAt = 0, now = Date.now(), minIntervalMs = MARINE_MIN_INTERVAL_MS }) {
  if (!points.length || now - lastFetchedAt < minIntervalMs) return null;
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat).join(','),
    longitude: points.map((p) => p.lng).join(','),
    current: 'wave_height,swell_wave_height,wave_direction,wave_period',
    daily: 'wave_height_max,swell_wave_height_max,wave_period_max',
    forecast_days: '3',
    timezone: 'Asia/Kolkata'
  });
  const { json } = await http.getJson(`${MARINE_URL}?${params}`, { timeoutMs: 30000 });
  const rows = Array.isArray(json) ? json : [json];
  if (rows.length !== points.length) throw new Error(`marine: expected ${points.length} locations, got ${rows.length}`);
  return points.map((p, i) => {
    const r = rows[i] || {};
    const d = r.daily || {};
    const days = (d.time || []).slice(0, 3).map((date, k) => ({
      date, maxM: round1(d.wave_height_max?.[k]), swellM: round1(d.swell_wave_height_max?.[k]), periodS: round1(d.wave_period_max?.[k])
    }));
    const valid = days.filter((x) => Number.isFinite(x.maxM));
    /* Today and tomorrow only: the third day is the least reliable. */
    const peak = valid.slice(0, 2).reduce((best, x) => (!best || x.maxM > best.maxM ? x : best), null);
    const c = r.current || {};
    return {
      id: p.id, name: p.name, lat: p.lat, lng: p.lng,
      nowM: round1(c.wave_height), swellNowM: round1(c.swell_wave_height),
      directionDeg: Number.isFinite(c.wave_direction) ? Math.round(c.wave_direction) : null,
      periodS: round1(c.wave_period),
      days, peakM: peak ? peak.maxM : null, peakDate: peak ? peak.date : null,
      state: seaState(peak ? peak.maxM : null)
    };
  });
}

/**
 * One alert for the whole coast per severity and day, listing the affected points, so a
 * cyclone does not produce ten separate messages.
 */
export function assessSea(points, { roughM = 2.5, veryRoughM = 4 } = {}) {
  const hits = points.filter((p) => Number.isFinite(p.peakM) && p.peakM >= roughM);
  if (!hits.length) return null;
  const worst = hits.reduce((a, b) => (b.peakM > a.peakM ? b : a));
  const severity = worst.peakM >= veryRoughM ? 'high' : 'medium';
  return {
    severity, worst, date: worst.peakDate,
    points: hits.sort((a, b) => b.peakM - a.peakM).map((p) => `${p.name} ${p.peakM} m`)
  };
}
