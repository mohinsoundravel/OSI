/**
 * Open-Meteo (free, no key, CC BY 4.0):
 *  - Flood API: GloFAS river discharge forecasts (m3/s) per coordinate.
 *  - Forecast API: daily maximum temperature per coordinate.
 * All points are batched into a single request per API (comma-separated
 * latitude/longitude lists), so cost does not grow with the number of points.
 */

const FLOOD_URL = 'https://flood-api.open-meteo.com/v1/flood';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const asArray = (json) => (Array.isArray(json) ? json : [json]);
const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

function batchUrl(base, points, params) {
  const q = new URLSearchParams({
    latitude: points.map((p) => p.lat).join(','),
    longitude: points.map((p) => p.lng).join(','),
    timezone: 'Asia/Kolkata',
    ...params
  });
  return `${base}?${q}`;
}

/* ---------------- Flood (river discharge) ---------------- */

export async function fetchRiverDischarge({ http, points, today }) {
  if (!points.length) return [];
  const { json } = await http.getJson(batchUrl(FLOOD_URL, points, {
    daily: 'river_discharge,river_discharge_max',
    past_days: '7',
    forecast_days: '7'
  }));
  const results = asArray(json);
  if (results.length !== points.length) throw new Error(`flood API returned ${results.length} results for ${points.length} points`);

  return points.map((p, i) => {
    const d = results[i]?.daily;
    if (!d || !Array.isArray(d.time)) throw new Error(`flood API: no daily data for ${p.id}`);
    const past = [];
    const future = [];
    d.time.forEach((t, k) => {
      const row = { date: t, q: d.river_discharge?.[k], qMax: d.river_discharge_max?.[k] };
      (t < today ? past : future).push(row);
    });
    const pastVals = past.map((r) => r.q).filter(Number.isFinite);
    const baseline = pastVals.length ? pastVals.reduce((a, b) => a + b, 0) / pastVals.length : null;
    const peak = future.reduce((best, r) => (Number.isFinite(r.q) && (!best || r.q > best.q) ? r : best), null);
    const upper = future.reduce((m, r) => (Number.isFinite(r.qMax) ? Math.max(m, r.qMax) : m), -Infinity);
    return {
      id: p.id, name: p.name, lat: p.lat, lng: p.lng,
      baseline: round(baseline), peak: round(peak?.q), peakDate: peak?.date || null,
      ensembleMax: Number.isFinite(upper) ? round(upper) : null,
      ratio: baseline > 0 && peak ? round(peak.q / baseline, 2) : null,
      warningLevel: p.warningDischarge ?? null,
      dangerLevel: p.dangerDischarge ?? null,
      minDischarge: p.minDischarge ?? 50,
      series: future.map((r) => ({ date: r.date, q: round(r.q) }))
    };
  });
}

/**
 * Derived river-flood signal. GloFAS via Open-Meteo has no return-period
 * thresholds, so the default test is relative: forecast peak against the mean
 * of the past 7 days, gated by an absolute floor so small streams do not alert.
 * Points may define warningDischarge / dangerDischarge (m3/s) to use absolute
 * levels instead, which is more reliable when the levels are known.
 */
export function assessRiver(r, { ratioMedium = 2, ratioHigh = 4 } = {}) {
  if (!Number.isFinite(r.peak)) return null;
  if (Number.isFinite(r.dangerLevel) && r.peak >= r.dangerLevel) return { severity: 'critical', reason: `forecast peak ${r.peak} m3/s at or above danger level ${r.dangerLevel}` };
  if (Number.isFinite(r.warningLevel) && r.peak >= r.warningLevel) return { severity: 'high', reason: `forecast peak ${r.peak} m3/s at or above warning level ${r.warningLevel}` };
  if (r.peak < r.minDischarge || !Number.isFinite(r.ratio)) return null;
  if (r.ratio >= ratioHigh) return { severity: 'high', reason: `forecast peak ${r.ratio}x the 7-day mean (${r.baseline} -> ${r.peak} m3/s)` };
  if (r.ratio >= ratioMedium) return { severity: 'medium', reason: `forecast peak ${r.ratio}x the 7-day mean (${r.baseline} -> ${r.peak} m3/s)` };
  return null;
}

/* ---------------- Heat (IMD criteria) ---------------- */

export async function fetchTemperatures({ http, points }) {
  if (!points.length) return [];
  const { json } = await http.getJson(batchUrl(FORECAST_URL, points, {
    daily: 'temperature_2m_max',
    past_days: '1',
    forecast_days: '4'
  }));
  const results = asArray(json);
  if (results.length !== points.length) throw new Error(`forecast API returned ${results.length} results for ${points.length} points`);
  return points.map((p, i) => {
    const d = results[i]?.daily;
    if (!d || !Array.isArray(d.time)) throw new Error(`forecast API: no daily data for ${p.id}`);
    return {
      id: p.id, name: p.name, lat: p.lat, lng: p.lng, region: p.region || 'plains',
      days: d.time.map((t, k) => ({ date: t, tmax: round(d.temperature_2m_max?.[k]) }))
    };
  });
}

const REGION_THRESHOLD = { plains: 40, coastal: 37, hilly: 30 };

/**
 * Classifies one day using IMD's station criteria:
 *  - The region threshold must be reached (40 C plains, 37 C coastal, 30 C hilly).
 *  - Departure from normal 4.5-6.4 C = heat wave, > 6.4 C = severe heat wave.
 *  - Independently of normal: actual max >= 45 C = heat wave, >= 47 C = severe.
 * Without a normal, only the absolute criterion can be evaluated.
 */
export function classifyHeatDay(tmax, region, normal) {
  if (!Number.isFinite(tmax)) return null;
  if (tmax >= 47) return 'severe';
  let level = tmax >= 45 ? 'heatwave' : null;
  const threshold = REGION_THRESHOLD[region] ?? REGION_THRESHOLD.plains;
  if (Number.isFinite(normal) && tmax >= threshold) {
    const departure = tmax - normal;
    if (departure > 6.4) return 'severe';
    if (departure >= 4.5) level = 'heatwave';
  }
  return level;
}

/**
 * IMD declares a heat wave when criteria hold on two consecutive days. A single
 * point cannot satisfy IMD's "two stations" rule, which is one reason these
 * alerts are labelled as derived rather than official.
 */
export function assessHeat(point, normalsByMonth) {
  const levels = point.days.map((d) => {
    const month = Number(d.date.slice(5, 7)) - 1;
    const normal = normalsByMonth ? normalsByMonth[month] : undefined;
    return { ...d, normal: Number.isFinite(normal) ? normal : null, level: classifyHeatDay(d.tmax, point.region, normal) };
  });
  let best = null;
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1];
    const b = levels[i];
    if (!a.level || !b.level) continue;
    const severe = a.level === 'severe' && b.level === 'severe';
    const candidate = { severity: severe ? 'critical' : 'high', label: severe ? 'Severe heat wave' : 'Heat wave', from: a.date, to: b.date, tmax: Math.max(a.tmax, b.tmax), normal: b.normal };
    if (!best || (candidate.severity === 'critical' && best.severity !== 'critical')) best = candidate;
  }
  return { days: levels, alert: best, usedNormals: Boolean(normalsByMonth) };
}
