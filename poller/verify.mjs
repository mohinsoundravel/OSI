/**
 * River forecast check: did the rise each alert forecast actually happen?
 *
 * When a river-rise alert is sent, the forecast is recorded (point, peak date, forecast
 * peak, the 7-day mean it was compared with, lead time). Every run already downloads the
 * past 7 days for each point, so once the peak date has passed the record is settled from
 * those values, with no extra requests:
 *   - happened: the highest flow within a day of the peak date reached the alert's rise
 *     threshold (the 7-day mean times flood.ratioMedium, or the point's warning level);
 *   - partly:   it rose at least 30% above the mean but stayed below that threshold;
 *   - did not happen: anything less.
 * The "observed" values are GloFAS's own later estimates (model analysis), not river
 * gauges: this measures whether forecast rises survive into the model's best estimate,
 * which is the usual way forecast alerts turn out to be noise.
 */

const DAY_MS = 24 * 3600 * 1000;
const KEEP_MS = 60 * DAY_MS;
const IST_MS = 5.5 * 3600 * 1000;
const istDate = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

function threshold(rec, ratioMedium) {
  return Number.isFinite(rec.warningLevel) ? rec.warningLevel : rec.baseline * ratioMedium;
}

/** Records a forecast behind a river alert; one record per point and peak date. */
export function recordForecast(state, { pointId, name, severity, issuedAt, peakDate, peak, baseline, warningLevel = null }) {
  if (!pointId || !/^\d{4}-\d{2}-\d{2}$/.test(String(peakDate)) || !Number.isFinite(peak) || !Number.isFinite(baseline)) return;
  state.forecastChecks ||= {};
  const id = `${pointId}:${peakDate}`;
  const prev = state.forecastChecks[id];
  const leadDays = Math.round((Date.parse(`${peakDate}T00:00:00Z`) - Date.parse(`${istDate(Date.parse(issuedAt))}T00:00:00Z`)) / DAY_MS);
  if (prev) {
    /* Keep the first issue time (the lead time the alert was sent with) and the highest severity. */
    if (severity === 'high' || severity === 'critical') prev.severity = severity;
    return;
  }
  state.forecastChecks[id] = {
    pointId, name, severity, issuedAt, peakDate, leadDays, forecastPeak: peak, baseline,
    warningLevel: Number.isFinite(warningLevel) ? warningLevel : null, status: 'pending'
  };
}

/** River alerts already in events.json (from before the check existed), parsed from their text. */
export function seedFromEvents(state, events, rivers = []) {
  const names = new Map(rivers.map((r) => [r.id, r.name]));
  let n = 0;
  for (const e of events) {
    if (e.rule !== 'river_discharge' || e.baseline) continue;
    const id = /^river:([^:]+):/.exec(String(e.id || ''))?.[1];
    const m = /\(([\d.]+) -> ([\d.]+) m3\/s\); peak expected (\d{4}-\d{2}-\d{2})/.exec(String(e.summary || ''));
    if (!id || !m) continue;
    const before = Object.keys(state.forecastChecks || {}).length;
    recordForecast(state, {
      pointId: id, name: names.get(id) || String(e.title || id).replace(/^River rise forecast: /, ''),
      severity: e.severity, issuedAt: e.detectedAt, peakDate: m[3], peak: Number(m[2]), baseline: Number(m[1])
    });
    if (Object.keys(state.forecastChecks).length > before) n++;
  }
  return n;
}

/** Settles pending records whose peak date has passed, from this run's past values. */
export function verifyForecasts(state, rivers, { now, ratioMedium = 2 } = {}) {
  const checks = state.forecastChecks || {};
  const today = istDate(now);
  const byId = new Map(rivers.map((r) => [r.id, r]));
  let settled = 0;
  for (const [id, rec] of Object.entries(checks)) {
    if (now - Date.parse(rec.issuedAt) > KEEP_MS) { delete checks[id]; continue; }
    if (rec.status !== 'pending') continue;
    /* The day after the peak must be complete as well (the peak may come a day late). */
    if (addDays(rec.peakDate, 1) >= today) continue;
    const past = byId.get(rec.pointId)?.past || [];
    const window = past.filter((p) => p.date >= addDays(rec.peakDate, -1) && p.date <= addDays(rec.peakDate, 1) && Number.isFinite(p.q));
    if (!window.length) {
      /* Older than the 7 days each run downloads: cannot be checked any more. */
      if (rec.peakDate < addDays(today, -6)) { rec.status = 'unverifiable'; settled++; }
      continue;
    }
    const observed = Math.max(...window.map((p) => p.q));
    const limit = threshold(rec, ratioMedium);
    rec.observedPeak = Math.round(observed * 10) / 10;
    rec.status = observed >= limit ? 'happened' : observed >= rec.baseline * 1.3 ? 'partly' : 'missed';
    rec.checkedAt = new Date(now).toISOString();
    settled++;
  }
  return settled;
}

/** Totals over the last `days` days, per point and per lead time. */
export function forecastSkill(state, { now, days = 30 } = {}) {
  const recs = Object.values(state.forecastChecks || {})
    .filter((r) => ['happened', 'partly', 'missed'].includes(r.status) && now - Date.parse(r.issuedAt) <= days * DAY_MS);
  const count = (list) => ({
    checked: list.length,
    happened: list.filter((r) => r.status === 'happened').length,
    partly: list.filter((r) => r.status === 'partly').length,
    missed: list.filter((r) => r.status === 'missed').length
  });
  const byPoint = {};
  for (const r of recs) (byPoint[r.pointId] ||= { name: r.name, list: [] }).list.push(r);
  const lead = (lo, hi) => count(recs.filter((r) => r.leadDays >= lo && r.leadDays <= hi));
  return {
    days, ...count(recs),
    pending: Object.values(state.forecastChecks || {}).filter((r) => r.status === 'pending').length,
    byLead: { '0-3 days': lead(-1, 3), '4-7 days': lead(4, 9) },
    byPoint: Object.fromEntries(Object.entries(byPoint).map(([id, v]) => [id, { name: v.name, ...count(v.list) }]))
  };
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : 'n/a');

/** Lines for the weekly review and /review. */
export function forecastReviewLines(skill) {
  const lines = [`River forecast check (last ${skill.days} days, against the model's later estimate):`];
  if (!skill.checked) {
    lines.push(`- Nothing settled yet${skill.pending ? `; ${skill.pending} forecast(s) waiting for their peak date to pass` : ''}.`);
    return lines;
  }
  lines.push(`- ${skill.checked} checked: ${skill.happened} happened, ${skill.partly} partly, ${skill.missed} did not (${pct(skill.happened, skill.checked)} hit rate)${skill.pending ? `; ${skill.pending} pending` : ''}.`);
  const near = skill.byLead['0-3 days'];
  const far = skill.byLead['4-7 days'];
  if (near.checked || far.checked) lines.push(`- By lead time: peak within 3 days ${pct(near.happened, near.checked)} of ${near.checked}; 4 to 7 days ahead ${pct(far.happened, far.checked)} of ${far.checked}.`);
  const weak = Object.entries(skill.byPoint).filter(([, p]) => p.checked >= 3 && p.missed / p.checked >= 0.6)
    .sort((a, b) => b[1].missed - a[1].missed);
  for (const [id, p] of weak.slice(0, 4)) {
    lines.push(`- ${p.name}: ${p.missed} of ${p.checked} did not happen. Consider a higher minDischarge for "${id}" in flood.points.`);
  }
  if (far.checked >= 4 && near.checked >= 2 && far.happened / far.checked < 0.5 * Math.max(0.01, near.happened / near.checked)) {
    lines.push('- Forecasts 4 to 7 days ahead do much worse: consider limiting river alerts to peaks within 3 days.');
  }
  return lines;
}

/** One line for an alert's summary: how this point's past forecasts turned out. */
export function pointTrackRecord(skill, pointId) {
  const p = skill?.byPoint?.[pointId];
  if (!p || p.checked < 2) return '';
  return ` Past forecasts here (${skill.days} days): ${p.happened} of ${p.checked} rises happened.`;
}
