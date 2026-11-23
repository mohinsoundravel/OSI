/**
 * Backtest: replays past Tamil Nadu events through the poller's own rule functions.
 *
 * Rain:    forecasts as issued 0-6 days ahead (Open-Meteo Previous Runs API, the same
 *          default model the poller uses), plus ECMWF IFS 9 km single runs for comparison,
 *          scored against ERA5 daily rainfall at each district's reference point.
 * Rivers:  GloFAS daily flow (no archived forecasts exist), replayed as if the forecast had
 *          been perfect: tests the thresholds and the earliest possible alert, not the model.
 * Cyclone: every GDACS advisory (episode) for storms in the window, through the cyclone rule.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assessRiver, IMD_RAIN } from '../poller/sources/openmeteo.mjs';
import { parseCycloneGeometry, estimateLandfall, closestApproach, NIO } from '../poller/sources/cyclones.mjs';

const OUT = process.argv[2] || 'out';
const config = process.env.MONITOR_CONFIG_JSON ? JSON.parse(process.env.MONITOR_CONFIG_JSON) : JSON.parse(await readFile('config/monitor.json', 'utf8'));
const DISTRICTS = JSON.parse(await readFile('poller/data/districts.json', 'utf8')).districts
  .filter((d) => ['Tamil Nadu', 'Puducherry'].includes(d.state) && Number.isFinite(d.lat));
const FLOOD_POINTS = config.flood?.points || [];
const COAST_PLACES = config.cyclones?.places || config.sea?.points || [];
const WITHIN_KM = config.cyclones?.withinKm ?? 400;
const MAX_LEAD = 6;
const ALERT_LEAD = 2; /* The poller looks at today and the next two days. */

const EVENTS = [
  { id: 'fengal', name: 'Cyclone Fengal (Nov-Dec 2024)', from: '2024-11-26', to: '2024-12-03' },
  { id: 'south-tn', name: 'South Tamil Nadu extreme rain (Dec 2024)', from: '2024-12-10', to: '2024-12-15' },
  { id: 'chennai-oct', name: 'Chennai red alert (Oct 2024)', from: '2024-10-13', to: '2024-10-18' }
];

const DAY = 86400000;
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
const istDate = (isoUtc) => new Date(Date.parse(`${isoUtc}Z`) + 5.5 * 3600000).toISOString().slice(0, 10);
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'OSI-Monitor/1.0 (backtest)' }, signal: AbortSignal.timeout(90000) });
    } catch (err) {
      console.log(`retry after ${err.message}: ${url.slice(0, 90)}`);
      await sleep(8000 * (attempt + 1));
      continue;
    }
    if (res.status === 429 || res.status >= 500) { await sleep(8000 * (attempt + 1)); continue; }
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)} for ${url.slice(0, 160)}`);
    return JSON.parse(text);
  }
  throw new Error(`gave up after retries: ${url.slice(0, 160)}`);
}
const asArray = (j) => (Array.isArray(j) ? j : [j]);
const coords = (pts) => `latitude=${pts.map((p) => p.lat).join(',')}&longitude=${pts.map((p) => p.lng).join(',')}`;

/* ---------- Rain ---------- */

/** fc[district][date][lead] = mm forecast for that IST day, issued `lead` days earlier. */
async function previousRunsRain(from, to) {
  const vars = ['precipitation', ...Array.from({ length: MAX_LEAD }, (_, i) => `precipitation_previous_day${i + 1}`)];
  const json = asArray(await getJson(`https://previous-runs-api.open-meteo.com/v1/forecast?${coords(DISTRICTS)}&hourly=${vars.join(',')}&start_date=${from}&end_date=${to}&timezone=Asia%2FKolkata`));
  const out = {};
  DISTRICTS.forEach((d, i) => {
    const h = json[i].hourly;
    const byDay = (out[d.name] = {});
    h.time.forEach((t, k) => {
      const day = t.slice(0, 10);
      byDay[day] ||= Array(MAX_LEAD + 1).fill(0);
      vars.forEach((v, lead) => { const x = h[v]?.[k]; byDay[day][lead] = Number.isFinite(x) && Number.isFinite(byDay[day][lead]) ? byDay[day][lead] + x : null; });
    });
  });
  return out;
}

/** Same shape from ECMWF IFS 9 km 00 UTC runs (lead 0 misses 00:00-05:30 IST of that day). */
async function ecmwfRain(from, to) {
  const out = Object.fromEntries(DISTRICTS.map((d) => [d.name, {}]));
  for (const issue of daysBetween(addDays(from, -MAX_LEAD), to)) {
    let json;
    try {
      json = asArray(await getJson(`https://single-runs-api.open-meteo.com/v1/forecast?${coords(DISTRICTS)}&hourly=precipitation&models=ecmwf_ifs&run=${issue}T00:00&forecast_days=8`));
    } catch (err) { console.log(`ecmwf run ${issue}: ${err.message}`); continue; }
    DISTRICTS.forEach((d, i) => {
      const h = json[i]?.hourly;
      if (!h) return;
      const sums = {};
      h.time.forEach((t, k) => { const day = istDate(t); if (Number.isFinite(h.precipitation[k])) sums[day] = (sums[day] || 0) + h.precipitation[k]; });
      for (const [day, mm] of Object.entries(sums)) {
        const lead = Math.round((Date.parse(day) - Date.parse(issue)) / DAY);
        if (day < from || day > to || lead < 0 || lead > MAX_LEAD) continue;
        (out[d.name][day] ||= Array(MAX_LEAD + 1).fill(null))[lead] = mm;
      }
    });
    await sleep(300);
  }
  return out;
}

async function era5Rain(from, to) {
  const json = asArray(await getJson(`https://archive-api.open-meteo.com/v1/archive?${coords(DISTRICTS)}&daily=precipitation_sum&start_date=${from}&end_date=${to}&timezone=Asia%2FKolkata`));
  return Object.fromEntries(DISTRICTS.map((d, i) => [d.name, Object.fromEntries(json[i].daily.time.map((t, k) => [t, json[i].daily.precipitation_sum[k]]))]));
}

/**
 * For every district-day: observed category, forecast by lead, and the earliest lead at
 * which the poller's rule (forecast >= IMD very heavy within its 3-day window) would have
 * had an alert running. Scores at two thresholds to show what a lower trigger would buy.
 */
function scoreRain(days, fc, obs) {
  const cases = [];
  for (const d of DISTRICTS) {
    for (const day of days) {
      const f = fc[d.name]?.[day];
      const o = obs[d.name]?.[day];
      if (!f || !Number.isFinite(o)) continue;
      const earliest = (threshold, maxLead) => { let best = null; for (let k = 0; k <= maxLead; k++) if (Number.isFinite(f[k]) && f[k] >= threshold) best = k; return best; };
      cases.push({
        district: d.name, date: day, observed: r1(o), forecast: f.map(r1),
        alertLead: earliest(IMD_RAIN.veryHeavy, ALERT_LEAD),
        heavyLead: earliest(IMD_RAIN.heavy, ALERT_LEAD),
        longLead: earliest(IMD_RAIN.veryHeavy, MAX_LEAD)
      });
    }
  }
  const summary = (threshold, minLead) => {
    const event = (c) => c.observed >= IMD_RAIN.veryHeavy;
    const alerted = (c) => { const L = threshold === 'heavy' ? c.heavyLead : c.alertLead; return L !== null && L >= minLead; };
    const events = cases.filter(event);
    const alerts = cases.filter(alerted);
    return {
      observedVeryHeavy: events.length,
      warned: events.filter(alerted).length,
      alerts: alerts.length,
      falseAlarms: alerts.filter((c) => c.observed < IMD_RAIN.heavy).length,
      heavyNotVeryHeavy: alerts.filter((c) => c.observed >= IMD_RAIN.heavy && c.observed < IMD_RAIN.veryHeavy).length
    };
  };
  return {
    cases,
    scores: {
      'very heavy trigger, >=1 day ahead (current rule)': summary('veryHeavy', 1),
      'very heavy trigger, same day': summary('veryHeavy', 0),
      'heavy trigger, >=1 day ahead': summary('heavy', 1)
    }
  };
}

/* ---------- Rivers ---------- */

async function riverReplay(from, to) {
  const start = addDays(from, -14);
  const end = addDays(to, 10);
  const json = asArray(await getJson(`https://flood-api.open-meteo.com/v1/flood?${coords(FLOOD_POINTS)}&daily=river_discharge&start_date=${start}&end_date=${end}`));
  return FLOOD_POINTS.map((p, i) => {
    const series = json[i].daily.time.map((t, k) => ({ date: t, q: json[i].daily.river_discharge[k] }));
    const alerts = [];
    for (let x = 7; x + 6 < series.length; x++) {
      const issue = series[x].date;
      if (issue < addDays(from, -7) || issue > to) continue;
      const past = series.slice(x - 7, x).map((s) => s.q).filter(Number.isFinite);
      const future = series.slice(x, x + 7);
      const peak = future.reduce((b, s) => (Number.isFinite(s.q) && (!b || s.q > b.q) ? s : b), null);
      const baseline = past.reduce((a, b) => a + b, 0) / past.length;
      const v = assessRiver({
        peak: r1(peak?.q), baseline: r1(baseline), ratio: baseline > 0 && peak ? Math.round((peak.q / baseline) * 100) / 100 : null,
        minDischarge: p.minDischarge ?? 50, warningLevel: p.warningDischarge ?? null, dangerLevel: p.dangerDischarge ?? null
      }, config.flood || {});
      if (v) alerts.push({ issue, severity: v.severity, peakDate: peak.date, reason: v.reason });
    }
    const inWindow = series.filter((s) => s.date >= from && s.date <= addDays(to, 5));
    const peak = inWindow.reduce((b, s) => (Number.isFinite(s.q) && (!b || s.q > b.q) ? s : b), null);
    const before = series.filter((s) => s.date < from).slice(-7).map((s) => s.q).filter(Number.isFinite);
    const base = before.reduce((a, b) => a + b, 0) / (before.length || 1);
    return {
      id: p.id, name: p.name, minDischarge: p.minDischarge ?? 50,
      peak: peak ? { date: peak.date, q: r1(peak.q), timesBaseline: base > 0 ? r1(peak.q / base) : null } : null,
      baselineBefore: r1(base),
      firstAlert: alerts[0] || null,
      firstHigh: alerts.find((a) => a.severity === 'high') || null,
      alertDays: alerts.length
    };
  });
}

/* ---------- Cyclones ---------- */

async function cycloneReplay(from, to) {
  const list = await getJson(`https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC&fromdate=${addDays(from, -7)}&todate=${addDays(to, 2)}&alertlevel=Green;Orange;Red&pageSize=50`);
  const storms = (list?.features || []).filter((f) => {
    const [lng, lat] = f.geometry?.coordinates || [];
    return f.properties?.eventtype === 'TC' && lat >= NIO.minLat && lat <= NIO.maxLat && lng >= NIO.minLng && lng <= NIO.maxLng;
  });
  const out = [];
  for (const f of storms) {
    const { eventid, eventname, episodeid } = f.properties;
    const advisories = [];
    for (let ep = 1; ep <= Number(episodeid); ep++) {
      try {
        const epData = await getJson(`https://www.gdacs.org/gdacsapi/api/events/getepisodedata?eventtype=TC&eventid=${eventid}&episodeid=${ep}`);
        const p = epData?.properties || {};
        const issuedAt = `${p.todate || p.polygondate || p.fromdate}Z`;
        const geo = await getJson(`https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=TC&eventid=${eventid}&episodeid=${ep}`);
        const { track } = parseCycloneGeometry(geo, { issuedAt });
        const near = closestApproach(track, COAST_PLACES);
        const landfall = estimateLandfall(track);
        const alert = near && near.km <= WITHIN_KM && Date.parse(near.at) >= Date.parse(issuedAt) - 6 * 3600000
          ? { severity: near.km <= 150 ? 'high' : 'medium', tierKm: near.km <= 150 ? 150 : near.km <= 300 ? 300 : WITHIN_KM }
          : null;
        advisories.push({ episode: ep, issuedAt, alertLevel: p.alertlevel, wind: p.severitydata?.severitytext, closest: near, landfall, alert });
      } catch (err) { advisories.push({ episode: ep, error: err.message }); }
      await sleep(500);
    }
    out.push({ eventId: eventid, name: eventname, firstSeen: f.properties.fromdate, advisories });
  }
  return out;
}

/* ---------- Run ---------- */

const results = {};
for (const ev of EVENTS) {
  console.log(`\n### ${ev.name}`);
  const days = daysBetween(ev.from, ev.to);
  const res = (results[ev.id] = { name: ev.name, from: ev.from, to: ev.to });
  try {
    const obs = await era5Rain(ev.from, ev.to);
    const prev = await previousRunsRain(ev.from, ev.to);
    res.rainDefault = scoreRain(days, prev, obs);
    console.log('rain (default model)', JSON.stringify(res.rainDefault.scores));
    const ecm = await ecmwfRain(ev.from, ev.to);
    res.rainEcmwf = scoreRain(days, ecm, obs);
    console.log('rain (ECMWF 9 km)', JSON.stringify(res.rainEcmwf.scores));
  } catch (err) { res.rainError = err.message; console.log('rain error', err.message); }
  try { res.rivers = await riverReplay(ev.from, ev.to); } catch (err) { res.riverError = err.message; console.log('river error', err.message); }
  try { res.cyclones = await cycloneReplay(ev.from, ev.to); } catch (err) { res.cycloneError = err.message; console.log('cyclone error', err.message); }
}
await writeFile(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
console.log('\nwrote results.json');
