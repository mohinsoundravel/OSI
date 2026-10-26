/**
 * Scheduled summaries, built only from data the poller already has (no AI summarising):
 *  - a morning digest on Telegram (default 07:00 IST), separate from urgent alerts;
 *  - a daily log that every run updates, kept for 14 days;
 *  - a weekly India disaster brief (Markdown, kept on the data branch) and the weekly
 *    alert review, both on the configured weekday.
 */
import { SEVERITY_RANK } from './rules.mjs';
import { closestApproach } from './sources/cyclones.mjs';
import { seaState } from './sources/marine.mjs';

const DAY_MS = 24 * 3600 * 1000;
const IST_MS = 5.5 * 3600 * 1000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LOG_DAYS = 14;

export const istDate = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istHour = (ms) => new Date(ms + IST_MS).getUTCHours();
const istWeekday = (ms) => WEEKDAYS[new Date(ms + IST_MS).getUTCDay()];
export const istText = (iso) => {
  const d = new Date(Date.parse(iso) + IST_MS);
  return Number.isFinite(d.getTime()) ? `${d.toISOString().slice(8, 10)}/${d.toISOString().slice(5, 7)} ${d.toISOString().slice(11, 16)} IST` : '?';
};
const fmtInt = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-IN') : '?');

/** ISO 8601 week of an IST date, e.g. "2026-W44". */
export function isoWeek(ms) {
  const d = new Date(Date.UTC(...istDate(ms).split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0))));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function digestDue(state, now, { digestHour = 7 } = {}) {
  return istHour(now) >= digestHour && state.digestDate !== istDate(now);
}

export function weeklyDue(state, now, { digestHour = 7, weeklyDay = 'Sunday' } = {}) {
  return istWeekday(now) === weeklyDay && istHour(now) >= digestHour && state.weeklyWeek !== isoWeek(now);
}

const TN_STATES = new Set(['Tamil Nadu', 'Puducherry']);

function cycloneLine(c, coast, now) {
  const near = coast.length && c.track?.length ? closestApproach(c.track, coast) : null;
  const parts = [`${c.name} (GDACS ${c.alertLevel}${Number.isFinite(c.maxWindKmh) ? `, ${c.maxWindKmh} km/h` : ''}) at ${c.lat.toFixed(1)}N ${c.lng.toFixed(1)}E`];
  if (c.landfall) {
    parts.push(Date.parse(c.landfall.at) > now
      ? `landfall near ${c.landfall.near} about ${istText(c.landfall.at)} (forecast)`
      : `track crossed the coast near ${c.landfall.near} about ${istText(c.landfall.at)}`);
  }
  if (near) parts.push(`closest to the Tamil Nadu coast: ${near.km} km off ${near.place}`);
  return parts.join('; ');
}

/** The morning digest: one plain-text message. */
export function buildMorningDigest({ latest, events = [], state = {}, config = {}, now, dashboardUrl = null }) {
  const lines = [`OSI morning digest, ${istWeekday(now)} ${istDate(now)}`];
  const active = Array.isArray(latest.active) ? latest.active : [];
  const since = state.digestAt ? Date.parse(state.digestAt) : now - DAY_MS;
  const fresh = events.filter((e) => !e.baseline && Date.parse(e.detectedAt) > since)
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const bySev = ['critical', 'high', 'medium', 'low'].map((s) => [s, active.filter((a) => a.severity === s).length]).filter(([, n]) => n);
  lines.push('', `Alerts: ${active.length} active${bySev.length ? ` (${bySev.map(([s, n]) => `${n} ${s}`).join(', ')})` : ''}; ${fresh.length} new since the last digest.`);
  for (const e of fresh.slice(0, 6)) lines.push(`- [${e.severity}] ${e.title}`);
  if (fresh.length > 6) lines.push(`- and ${fresh.length - 6} more (/alerts)`);

  const layers = latest.layers || {};
  const coast = config.sea?.points || [];
  const cyclones = layers.cyclones || [];
  lines.push('', cyclones.length ? 'Cyclones (North Indian Ocean):' : 'Cyclones: none active in the North Indian Ocean.');
  for (const c of cyclones) lines.push(`- ${cycloneLine(c, coast, now)}`);

  const dams = (layers.reservoirs?.items || []).filter((d) => Number.isFinite(d.levelFt));
  if (dams.length) {
    const top = [...dams].sort((a, b) => (b.pctDepth ?? 0) - (a.pctDepth ?? 0)).slice(0, 4);
    const releases = [...dams].filter((d) => (d.outflow ?? 0) >= 1000).sort((a, b) => b.outflow - a.outflow).slice(0, 3);
    lines.push('', `Dams (${layers.reservoirs.date}): ${top.map((d) => `${d.name} ${d.levelFt}/${d.fullFt} ft`).join(', ')}.`);
    if (releases.length) lines.push(`Largest releases: ${releases.map((d) => `${d.name} ${fmtInt(d.outflow)} cusecs`).join(', ')}.`);
  }

  const rain = (layers.rain || []).filter((r) => TN_STATES.has(r.state) && Number.isFinite(r.next72)).sort((a, b) => b.next72 - a.next72);
  if (rain.length) lines.push('', `Rain, next 3 days (model): ${rain.slice(0, 5).map((r) => `${r.name} ${r.next72} mm`).join(', ')}.`);

  const sea = (layers.sea || []).filter((p) => Number.isFinite(p.peakM));
  if (sea.length) {
    const worst = sea.reduce((a, b) => (b.peakM > a.peakM ? b : a));
    lines.push(`Sea, next 48 h (model): highest ${worst.peakM} m off ${worst.name} (${seaState(worst.peakM).toLowerCase()}).`);
  }

  const fires = layers.fires;
  if (fires && Number.isFinite(fires.count)) {
    const areas = (fires.areas || []).filter((a) => a.count > 0);
    lines.push(`Fires, 24 h (FIRMS): ${areas.length ? areas.map((a) => `${a.name} ${a.count}`).join(', ') : 'none in watched forest areas'}; ${fmtInt(fires.count)} hotspots across South Asia.`);
  }

  const news = layers.news;
  if (news && Array.isArray(news.top)) {
    lines.push('', `News, last 48 h (GDELT, unverified): ${news.count} placed headlines${news.tnCount ? `, ${news.tnCount} in Tamil Nadu` : ''}.`);
    for (const n of news.top.slice(0, 3)) lines.push(`- ${n.title} (${n.place}; ${n.domain})`);
  }

  const failing = Object.entries(latest.health || {}).filter(([, h]) => !h.ok).map(([k]) => k);
  lines.push('', failing.length ? `Sources failing: ${failing.join(', ')}.` : 'All sources responding.');
  const muted = Object.entries(state.mutes || {}).filter(([, u]) => Date.parse(u) > now).map(([g]) => g);
  if (muted.length) lines.push(`Muted: ${muted.join(', ')} (/muted).`);
  if (dashboardUrl) lines.push(dashboardUrl);
  return lines.join('\n').slice(0, 3900);
}

/* ---------- Daily log (input to the weekly brief) ---------- */

/** Updates today's record from this run's outputs. Records keep the day's maxima and sets. */
export function updateDailyLog(log, { latest, events = [], now }) {
  const days = Array.isArray(log?.days) ? log.days : [];
  const date = istDate(now);
  let rec = days.find((d) => d.date === date);
  if (!rec) {
    rec = { date, alerts: {}, cyclones: {}, quakes: {}, gdacs: {}, rainMax: null, seaMax: null, fireAreas: {}, firesSouthAsia: 0, news: {}, dams: {} };
    days.push(rec);
  }
  const L = latest.layers || {};
  /* Alerts first detected today (IST), by rule and severity. */
  rec.alerts = {};
  for (const e of events) {
    if (e.baseline || istDate(Date.parse(e.detectedAt)) !== date) continue;
    const k = `${e.rule}|${e.severity}`;
    rec.alerts[k] = (rec.alerts[k] || 0) + 1;
  }
  rec.alertTitles = events.filter((e) => !e.baseline && istDate(Date.parse(e.detectedAt)) === date && SEVERITY_RANK[e.severity] >= 2)
    .slice(0, 15).map((e) => ({ title: String(e.title).slice(0, 160), severity: e.severity, origin: e.origin, url: e.sourceUrl || null }));
  for (const c of L.cyclones || []) {
    const prev = rec.cyclones[c.eventId] || {};
    rec.cyclones[c.eventId] = {
      name: c.name, alertLevel: c.alertLevel, maxWindKmh: Math.max(prev.maxWindKmh || 0, c.maxWindKmh || 0),
      lat: c.lat, lng: c.lng, landfall: c.landfall || prev.landfall || null, url: c.url
    };
  }
  for (const q of L.quakes || []) rec.quakes[q.id] = { mag: q.mag, place: q.place, url: q.url };
  for (const g of L.gdacs || []) rec.gdacs[g.id] = { name: g.name, type: g.type, level: g.alertLevel, country: g.country, url: g.url };
  const rain = (L.rain || []).filter((r) => Number.isFinite(r.peakMm)).sort((a, b) => b.peakMm - a.peakMm)[0];
  if (rain && (!rec.rainMax || rain.peakMm > rec.rainMax.mm)) rec.rainMax = { name: rain.name, state: rain.state, mm: rain.peakMm, date: rain.peakDate };
  const sea = (L.sea || []).filter((p) => Number.isFinite(p.peakM)).sort((a, b) => b.peakM - a.peakM)[0];
  if (sea && (!rec.seaMax || sea.peakM > rec.seaMax.m)) rec.seaMax = { name: sea.name, m: sea.peakM };
  if (L.fires) {
    rec.firesSouthAsia = Math.max(rec.firesSouthAsia || 0, L.fires.count || 0);
    for (const a of L.fires.areas || []) rec.fireAreas[a.name] = Math.max(rec.fireAreas[a.name] || 0, a.count || 0);
  }
  for (const n of L.news?.items || []) {
    if (istDate(Date.parse(n.at)) !== date) continue;
    rec.news[n.id] = { title: n.title, url: n.url, domain: n.domain, category: n.category, place: n.place, state: n.state, sources: n.sources };
  }
  const newsIds = Object.keys(rec.news);
  if (newsIds.length > 120) for (const id of newsIds.slice(0, newsIds.length - 120)) delete rec.news[id];
  for (const d of L.reservoirs?.items || []) if (Number.isFinite(d.levelFt)) rec.dams[d.name] = { levelFt: d.levelFt, fullFt: d.fullFt, outflow: d.outflow };
  const cutoff = istDate(now - LOG_DAYS * DAY_MS);
  return { schema: 1, days: days.filter((d) => d.date > cutoff).sort((a, b) => a.date.localeCompare(b.date)) };
}

/* ---------- Weekly brief (Markdown) ---------- */

const md = (s) => String(s ?? '').replace(/[\\`*_[\]<>|#]/g, (c) => `\\${c}`);
const link = (title, url) => (url && /^https?:\/\//.test(url) ? `[${md(title)}](${url.replace(/[()\s]/g, encodeURIComponent)})` : md(title));
const RULE_LABEL = {
  sachet_official: 'Official alerts (SACHET)', river_discharge: 'River-rise forecasts', rain_imd_category: 'Heavy-rain forecasts',
  heat_imd_criteria: 'Heat-wave forecasts', reservoir_release: 'Dam releases', reservoir_full: 'Reservoirs near full',
  gdacs_level: 'GDACS alerts', usgs_quake: 'Earthquakes', flight_squawk: 'Aircraft emergencies', cyclone_track: 'Cyclone approach',
  sea_state: 'Rough-sea forecasts', forest_fire: 'Forest fires'
};
const CATEGORY_LABEL = { security: 'Security', unrest: 'Public order', accident: 'Accidents and explosions', hazard: 'Natural hazards' };

export function buildWeeklyBrief({ log, now, dashboardUrl = null }) {
  const week = isoWeek(now);
  /* The ISO week that ends on the brief's day (Monday to Sunday, IST). */
  const end = istDate(now);
  const start = istDate(now - 6 * DAY_MS);
  const days = (log?.days || []).filter((d) => d.date >= start && d.date <= end);
  const out = [];
  out.push(`# India disaster and security brief, ${week} (${start} to ${end})`, '');
  out.push(`Compiled automatically on ${istText(new Date(now).toISOString())} from the OSI monitor's daily records: official feeds (SACHET, GDACS, USGS, WRD), model forecasts (Open-Meteo, GloFAS) and machine-collected headlines (GDELT). Not edited; verify against the linked sources before citing.`, '');
  if (!days.length) {
    out.push('No daily records for this week yet.');
    return { week, markdown: `${out.join('\n')}\n` };
  }

  /* Alerts by rule. */
  const byRule = {};
  for (const d of days) for (const [k, n] of Object.entries(d.alerts || {})) {
    const [rule, sev] = k.split('|');
    byRule[rule] ||= { total: 0, high: 0 };
    byRule[rule].total += n;
    if (SEVERITY_RANK[sev] >= 2) byRule[rule].high += n;
  }
  out.push('## Alerts in watched zones', '');
  const rules = Object.entries(byRule).sort((a, b) => b[1].total - a[1].total);
  if (rules.length) {
    out.push('| Kind | New alerts | High or critical |', '|---|---:|---:|');
    for (const [rule, v] of rules) out.push(`| ${RULE_LABEL[rule] || md(rule)} | ${v.total} | ${v.high} |`);
  } else {
    out.push('No new alerts.');
  }
  const notable = days.flatMap((d) => (d.alertTitles || []).map((a) => ({ ...a, date: d.date })));
  if (notable.length) {
    out.push('', 'High and critical:', '');
    for (const a of notable.slice(0, 20)) out.push(`- ${a.date}: ${link(a.title, a.url)} (${a.origin})`);
  }

  /* Cyclones. */
  const cyclones = {};
  for (const d of days) for (const [id, c] of Object.entries(d.cyclones || {})) cyclones[id] = { ...cyclones[id], ...c, maxWindKmh: Math.max(cyclones[id]?.maxWindKmh || 0, c.maxWindKmh || 0), last: d.date };
  out.push('', '## Cyclones (North Indian Ocean)', '');
  if (Object.keys(cyclones).length) {
    for (const c of Object.values(cyclones)) {
      out.push(`- ${link(c.name, c.url)}: peak GDACS level ${c.alertLevel}, max wind ${c.maxWindKmh || '?'} km/h, last seen ${c.last}${c.landfall ? `; forecast landfall near ${md(c.landfall.near)} about ${istText(c.landfall.at)}` : ''}.`);
    }
  } else {
    out.push('None.');
  }

  /* Rain, sea, dams. */
  out.push('', '## Rain, sea and reservoirs (Tamil Nadu)', '');
  const rainMax = days.map((d) => d.rainMax && { ...d.rainMax, day: d.date }).filter(Boolean).sort((a, b) => b.mm - a.mm)[0];
  if (rainMax) out.push(`- Heaviest forecast day: ${md(rainMax.name)}, ${rainMax.mm} mm on ${rainMax.date} (model; IMD very heavy is 115.6 mm).`);
  const seaMax = days.map((d) => d.seaMax).filter(Boolean).sort((a, b) => b.m - a.m)[0];
  if (seaMax) out.push(`- Highest forecast waves: ${seaMax.m} m off ${md(seaMax.name)} (${seaState(seaMax.m).toLowerCase()}).`);
  const first = days.find((d) => Object.keys(d.dams || {}).length);
  const last = [...days].reverse().find((d) => Object.keys(d.dams || {}).length);
  if (first && last) {
    const rows = Object.entries(last.dams).map(([name, v]) => {
      const before = first.dams[name];
      const change = before && Number.isFinite(before.levelFt) ? Math.round((v.levelFt - before.levelFt) * 100) / 100 : null;
      return { name, ...v, change };
    }).sort((a, b) => Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0)).slice(0, 8);
    out.push('', `| Reservoir | Level ${last.date} (ft) | Full (ft) | Change since ${first.date} (ft) | Outflow (cusecs) |`, '|---|---:|---:|---:|---:|');
    for (const r of rows) out.push(`| ${md(r.name)} | ${r.levelFt} | ${r.fullFt} | ${r.change === null ? '?' : `${r.change > 0 ? '+' : ''}${r.change}`} | ${fmtInt(r.outflow)} |`);
  }

  /* Earthquakes and global hazards touching India. */
  const quakes = {};
  const gdacs = {};
  for (const d of days) {
    Object.assign(quakes, d.quakes);
    Object.assign(gdacs, d.gdacs);
  }
  const indiaGdacs = Object.values(gdacs).filter((g) => /India|Sri Lanka|Bangladesh|Nepal|Pakistan|Myanmar|Bhutan/i.test(g.country || ''));
  out.push('', '## Earthquakes and other hazards', '');
  const qs = Object.values(quakes).sort((a, b) => b.mag - a.mag).slice(0, 10);
  if (qs.length) for (const q of qs) out.push(`- ${link(`M${q.mag.toFixed(1)} ${q.place}`, q.url)}`);
  for (const g of indiaGdacs.slice(0, 10)) out.push(`- ${link(`GDACS ${g.level}: ${g.type} ${g.name}`, g.url)} (${md(g.country)})`);
  if (!qs.length && !indiaGdacs.length) out.push('No M4+ earthquakes or GDACS Orange/Red events in the region.');

  /* Fires. */
  const fireAreas = {};
  for (const d of days) for (const [name, n] of Object.entries(d.fireAreas || {})) fireAreas[name] = (fireAreas[name] || 0) + n;
  const maxSouthAsia = Math.max(0, ...days.map((d) => d.firesSouthAsia || 0));
  out.push('', '## Fires (NASA FIRMS, VIIRS)', '');
  const fa = Object.entries(fireAreas).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  out.push(fa.length ? `- Watched Tamil Nadu forest areas (sum of daily maxima): ${fa.map(([n, c]) => `${md(n)} ${c}`).join(', ')}.` : '- No hotspots in watched Tamil Nadu forest areas.');
  if (maxSouthAsia) out.push(`- Busiest day across South Asia: ${fmtInt(maxSouthAsia)} hotspots (late-October peaks are mostly crop-residue burning in the north-west).`);

  /* Headlines. */
  const news = {};
  for (const d of days) for (const [id, n] of Object.entries(d.news || {})) news[id] = { ...n, date: d.date };
  const items = Object.values(news);
  out.push('', '## Headlines by category (GDELT, unverified)', '');
  if (!items.length) out.push('No placed headlines recorded.');
  for (const cat of ['security', 'unrest', 'accident', 'hazard']) {
    const list = items.filter((n) => n.category === cat).sort((a, b) => (b.sources || 1) - (a.sources || 1) || b.date.localeCompare(a.date));
    if (!list.length) continue;
    const states = {};
    for (const n of list) states[n.state] = (states[n.state] || 0) + 1;
    const topStates = Object.entries(states).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, c]) => `${md(s)} ${c}`).join(', ');
    out.push(`### ${CATEGORY_LABEL[cat]} (${list.length}; most: ${topStates})`, '');
    for (const n of list.slice(0, 8)) out.push(`- ${n.date}: ${link(n.title, n.url)} (${md(n.place)}; ${md(n.domain)})`);
    out.push('');
  }

  out.push('## Sources', '');
  out.push('SACHET (NDMA), GDACS, USGS, TN Agriculture Department (WRD reservoir data), Open-Meteo (forecast, flood, marine), NASA FIRMS, GDELT Project.');
  if (dashboardUrl) out.push('', `Live dashboard: ${dashboardUrl}`);
  return { week, markdown: `${out.join('\n')}\n` };
}
