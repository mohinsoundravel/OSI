/** Trend charts (inline SVG) and item detail. */
import { esc, getJson } from '../core.js';
import { backendBase, lastBackend, rainColor } from '../layers.js';
import { fmtInt } from './brief.js';

const CH = { w: 320, h: 132, l: 34, r: 8, t: 10, b: 22 };
export const shortDate = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '';
};
const istToday = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

function chartSvg(inner, aria, h = CH.h) {
  return `<svg class="chart" viewBox="0 0 ${CH.w} ${h}" role="img" aria-label="${esc(aria)}">${inner}</svg>`;
}
function axisY(min, max, fmt, h = CH.h) {
  const y = (v) => CH.t + (1 - (v - min) / (max - min || 1)) * (h - CH.t - CH.b);
  const ticks = [min, (min + max) / 2, max];
  return { y, svg: ticks.map((v) => `<line class="grid" x1="${CH.l}" x2="${CH.w - CH.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="tick" x="${CH.l - 4}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${esc(fmt(v))}</text>`).join('') };
}
const xScale = (n) => (i) => CH.l + (n <= 1 ? 0.5 : i / (n - 1)) * (CH.w - CH.l - CH.r);
const pathOf = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');

/** Dam level over the stored history, against full depth, with daily inflow as faint bars. */
function damChart(rows, fullFt) {
  const data = rows.filter((r) => Number.isFinite(r[1])).slice(-45);
  if (data.length < 2) return '<div class="chart-note">Trend appears after a few days of history.</div>';
  const levels = data.map((r) => r[1]);
  const lo = Math.floor(Math.min(...levels) - 2);
  const hi = Math.max(Math.ceil(fullFt), Math.ceil(Math.max(...levels) + 2));
  const { y, svg } = axisY(lo, hi, (v) => `${Math.round(v)}`);
  const x = xScale(data.length);
  const inflows = data.map((r) => (Number.isFinite(r[2]) ? r[2] : 0));
  const maxIn = Math.max(1, ...inflows);
  const barW = Math.min(12, Math.max(1.5, (CH.w - CH.l - CH.r) / data.length - 1.5));
  const bars = data.map((r, i) => {
    const bh = (inflows[i] / maxIn) * 34;
    const bx = Math.min(CH.w - CH.r - barW, Math.max(CH.l, x(i) - barW / 2));
    return `<rect class="bar-in" x="${bx.toFixed(1)}" y="${(CH.h - CH.b - bh).toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}"/>`;
  }).join('');
  const line = pathOf(data.map((r, i) => [x(i), y(r[1])]));
  const last = data[data.length - 1];
  return chartSvg(`${svg}${bars}
      <line class="ref" x1="${CH.l}" x2="${CH.w - CH.r}" y1="${y(fullFt).toFixed(1)}" y2="${y(fullFt).toFixed(1)}"/>
      <text class="ref-label" x="${CH.w - CH.r}" y="${(y(fullFt) - 3).toFixed(1)}" text-anchor="end">full ${Math.round(fullFt)} ft</text>
      <path class="line dam" d="${line}"/>
      <circle class="dot-end" cx="${x(data.length - 1).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="3"/>
      <text class="tick" x="${CH.l}" y="${CH.h - 6}">${esc(shortDate(data[0][0]))}</text>
      <text class="tick" x="${CH.w - CH.r}" y="${CH.h - 6}" text-anchor="end">${esc(shortDate(last[0]))}</text>`,
    `Level over ${data.length} days, from ${data[0][1]} to ${last[1]} feet; full is ${fullFt} feet`)
    + `<div class="chart-legend"><span><i class="k-dam"></i>Level (ft)</span><span><i class="k-in"></i>Inflow (relative, max ${fmtInt(maxIn)} cusecs)</span></div>`;
}

/** River discharge: 7 days observed-model past (solid) and forecast (dashed), today marked. */
function riverChart(r) {
  const series = (Array.isArray(r.series) ? r.series : []).filter((p) => Number.isFinite(p.q) && typeof p.date === 'string');
  if (series.length < 2) return '';
  const qs = series.map((p) => p.q);
  const hi = Math.max(...qs, r.baseline || 0) * 1.1 || 1;
  const { y, svg } = axisY(0, hi, (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`));
  const x = xScale(series.length);
  const today = istToday();
  let ti = series.findIndex((p) => p.date >= today);
  if (ti < 0) ti = series.length - 1;
  const pts = series.map((p, i) => [x(i), y(p.q)]);
  const past = pathOf(pts.slice(0, ti + 1));
  const future = pathOf(pts.slice(ti));
  const base = Number.isFinite(r.baseline) ? `<line class="ref" x1="${CH.l}" x2="${CH.w - CH.r}" y1="${y(r.baseline).toFixed(1)}" y2="${y(r.baseline).toFixed(1)}"/><text class="ref-label" x="${CH.l + 4}" y="${(y(r.baseline) - 3).toFixed(1)}">7-day mean</text>` : '';
  return chartSvg(`${svg}${base}
      <line class="today" x1="${x(ti).toFixed(1)}" x2="${x(ti).toFixed(1)}" y1="${CH.t}" y2="${CH.h - CH.b}"/>
      <text class="tick" x="${x(ti).toFixed(1)}" y="${CH.h - 6}" text-anchor="middle">today</text>
      <path class="line river" d="${past}"/><path class="line river fc" d="${future}"/>
      <text class="tick" x="${CH.l}" y="${CH.h - 6}">${esc(shortDate(series[0].date))}</text>
      <text class="tick" x="${CH.w - CH.r}" y="${CH.h - 6}" text-anchor="end">${esc(shortDate(series[series.length - 1].date))}</text>`,
    `River discharge in cubic metres per second, peak ${Math.round(Math.max(...qs))}`)
    + '<div class="chart-legend"><span><i class="k-river"></i>Discharge (m3/s), model</span><span><i class="k-fc"></i>Forecast</span></div>';
}

/** Daily maximum temperature forecast with the IMD heat-wave threshold for the region. */
function heatChart(h) {
  const days = (Array.isArray(h.days) ? h.days : []).filter((d) => Number.isFinite(d.tmax)).slice(0, 10);
  if (!days.length) return '';
  const threshold = { plains: 40, coastal: 37, hilly: 30 }[h.region] || 40;
  const lo = Math.floor(Math.min(...days.map((d) => d.tmax), threshold) - 3);
  const hi = Math.ceil(Math.max(...days.map((d) => d.tmax), threshold) + 1);
  const { y, svg } = axisY(lo, hi, (v) => `${Math.round(v)}`);
  const slot = (CH.w - CH.l - CH.r) / days.length;
  const bars = days.map((d, i) => {
    const bx = CH.l + i * slot + slot * 0.18;
    const top = y(d.tmax);
    const label = new Date(`${d.date}T00:00:00Z`).toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' });
    return `<rect class="bar-heat${d.tmax >= threshold ? ' hot' : ''}" x="${bx.toFixed(1)}" y="${top.toFixed(1)}" width="${(slot * 0.64).toFixed(1)}" height="${(CH.h - CH.b - top).toFixed(1)}" rx="2"/>
        <text class="tick" x="${(bx + slot * 0.32).toFixed(1)}" y="${CH.h - 6}" text-anchor="middle">${esc(label)}</text>`;
  }).join('');
  return chartSvg(`${svg}${bars}
      <line class="ref" x1="${CH.l}" x2="${CH.w - CH.r}" y1="${y(threshold).toFixed(1)}" y2="${y(threshold).toFixed(1)}"/>
      <text class="ref-label" x="${CH.w - CH.r}" y="${(y(threshold) - 3).toFixed(1)}" text-anchor="end">IMD ${threshold} C (${esc(h.region || 'plains')})</text>`,
    `Forecast daily maximum temperature, highest ${Math.max(...days.map((d) => d.tmax))} C`)
    + '<div class="chart-legend"><span><i class="k-heat"></i>Max temperature (C), forecast</span><span><i class="k-hot"></i>At or above the IMD threshold</span></div>';
}

/** Daily rain: yesterday (model) and the next three days, against IMD heavy / very heavy lines. */
function rainChart(r) {
  const days = (Array.isArray(r.days) ? r.days : []).filter((d) => typeof d.date === 'string');
  if (!days.length) return '';
  const hi = Math.max(130, ...days.map((d) => (Number.isFinite(d.mm) ? d.mm : 0))) * 1.08;
  const { y, svg } = axisY(0, hi, (v) => `${Math.round(v)}`);
  const slot = (CH.w - CH.l - CH.r) / days.length;
  const bars = days.map((d, i) => {
    const mm = Number.isFinite(d.mm) ? d.mm : 0;
    const bx = CH.l + i * slot + slot * 0.2;
    const top = y(mm);
    const label = i === 0 ? 'last 24 h' : new Date(`${d.date}T00:00:00Z`).toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' });
    return `<rect x="${bx.toFixed(1)}" y="${top.toFixed(1)}" width="${(slot * 0.6).toFixed(1)}" height="${(CH.h - CH.b - top).toFixed(1)}" rx="2" fill="${rainColor(mm)}" opacity="${i === 0 ? 0.55 : 0.9}"/>
        <text class="tick" x="${(bx + slot * 0.3).toFixed(1)}" y="${(top - 3).toFixed(1)}" text-anchor="middle">${Math.round(mm)}</text>
        <text class="tick" x="${(bx + slot * 0.3).toFixed(1)}" y="${CH.h - 6}" text-anchor="middle">${esc(label)}</text>`;
  }).join('');
  const line = (v, label) => `<line class="ref" x1="${CH.l}" x2="${CH.w - CH.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="ref-label" x="${CH.w - CH.r}" y="${(y(v) - 3).toFixed(1)}" text-anchor="end">${label}</text>`;
  return chartSvg(`${svg}${line(64.5, 'heavy 64.5')}${line(115.6, 'very heavy 115.6')}${bars}`, `Rain in millimetres per day; 3-day forecast total ${r.next72}`)
    + '<div class="chart-legend"><span>mm per day, model forecast; dashed lines are IMD 24-hour categories</span></div>';
}

let damHistory = null;
let damHistoryAt = 0;
async function loadDamHistory() {
  if (damHistory && Date.now() - damHistoryAt < 10 * 60 * 1000) return damHistory;
  const base = backendBase();
  if (!base) return null;
  try {
    const h = await getJson(`${base.replace(/\/+$/, '')}/reservoir-history.json?t=${Math.floor(Date.now() / 600000)}`);
    if (h && h.dams && typeof h.dams === 'object') {
      damHistory = h;
      damHistoryAt = Date.now();
    }
  } catch { /* charts are optional */ }
  return damHistory;
}

/** Fills the detail panel's chart slot for dams, river points and heat stations (and their alerts). */
export async function attachChart(key, it) {
  const slot = document.querySelector('#detail .chart-slot');
  if (!slot || key !== 'alerts' || !it || typeof it.id !== 'string') return;
  const [kind, pid] = it.id.split(':');
  const layers = lastBackend && lastBackend.layers ? lastBackend.layers : {};
  if (kind === 'river') {
    const r = (layers.rivers || []).find((x) => x.id === pid);
    if (r) slot.innerHTML = `<div class="chart-title">River discharge, 7 days back and ahead</div>${riverChart(r)}`;
  } else if (kind === 'rain') {
    const r = (layers.rain || []).find((x) => x.id === pid);
    if (r) slot.innerHTML = `<div class="chart-title">Rain, last 24 h and next 3 days</div>${rainChart(r)}`;
  } else if (kind === 'heat') {
    const h = (layers.heat || []).find((x) => x.id === pid);
    if (h) slot.innerHTML = `<div class="chart-title">Temperature forecast</div>${heatChart(h)}`;
  } else if (kind === 'reservoir') {
    const site = (layers.reservoirs && layers.reservoirs.items || []).find((x) => x.id === pid);
    slot.innerHTML = '<div class="chart-note">Loading level history\u2026</div>';
    const hist = await loadDamHistory();
    if (!document.body.contains(slot)) return;
    const rows = hist && Array.isArray(hist.dams[pid]) ? hist.dams[pid] : [];
    const fullFt = site ? site.fullFt : rows.length ? rows[rows.length - 1][4] : null;
    slot.innerHTML = rows.length && Number.isFinite(fullFt)
      ? `<div class="chart-title">Level, last ${Math.min(rows.length, 45)} days</div>${damChart(rows, fullFt)}`
      : '<div class="chart-note">History is building (a few days are added each hour).</div>';
  }
}
