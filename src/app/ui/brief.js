/** Situation brief for Tamil Nadu. */
import { appState } from '../app-state.js';
import { $, DEMO, GDACS_COLOR, RADIUS, SEV_COLOR, esc, haversineKm, num, relTime } from '../core.js';
import { BACKEND_STALE_MS, lastBackend, rainColor, str } from '../layers.js';
import { AIS_STATUS } from '../snapshots.js';
import { data } from '../state.js';
import { spotAlerts } from '../spots.js';
import { flyTo } from '../camera.js';
import { nearest } from '../place-info.js';
import { SEV_RANK_N } from '../tags.js';
import { showItemDetail } from './detail.js';
import { shortDate } from './charts.js';
import { istText } from '../hazards.js';

/* ----- Situation brief: what matters in Tamil Nadu right now, in a few tappable lines ----- */
export const BRIEF_SOURCES = new Set(['alerts', 'gdacs', 'quakes', 'ships', 'cyclones', 'sea', 'fires', 'news']);
const TN = { lat: 10.9, lng: 78.4 };
const briefTargets = [];
export const fmtInt = (v) => Math.round(v).toLocaleString('en-IN');

function briefRows() {
  const rows = [];
  const add = (color, text, target, sub = '') => rows.push({ color, text, sub, target });
  const alerts = (data.alerts || []).filter((it) => it.isAlert)
    .sort((a, b) => (SEV_RANK_N[b.alertSeverity] || 0) - (SEV_RANK_N[a.alertSeverity] || 0));
  if (!alerts.length) add('#30d158', 'No active official or derived alerts in your zones', null);
  for (const a of alerts.slice(0, 3)) add(SEV_COLOR[a.alertSeverity], a.title, { key: 'alerts', id: a.id }, a.origin === 'official' ? 'Official' : 'Derived');
  if (alerts.length > 3) add('#8b93a1', `${alerts.length - 3} more alert${alerts.length - 3 === 1 ? '' : 's'} in the feed`, null);

  const rainAll = lastBackend && lastBackend.layers && Array.isArray(lastBackend.layers.rain) ? lastBackend.layers.rain : [];
  for (const sp of appState.spots) {
    const near = spotAlerts(sp).sort((a, b) => (SEV_RANK_N[b.alertSeverity] || 0) - (SEV_RANK_N[a.alertSeverity] || 0));
    const rain = nearest(rainAll, sp.lat, sp.lng);
    const rainText = rain && rain.d < 80 ? ` \u00b7 rain ${num(rain.p.next72, 0)} mm / 3 days` : '';
    add(near.length ? SEV_COLOR[near[0].alertSeverity] : '#c58af7',
      near.length ? `${sp.name}: ${near.length} alert${near.length === 1 ? '' : 's'}, ${near[0].title}${rainText}` : `${sp.name}: all clear${rainText}`,
      near.length ? { key: 'alerts', id: near[0].id } : { lat: sp.lat, lng: sp.lng }, `Your watch spot \u00b7 ${sp.radiusKm} km`);
  }

  const res = lastBackend && lastBackend.layers && lastBackend.layers.reservoirs;
  const dams = res && Array.isArray(res.items) ? res.items.filter((d) => Number.isFinite(d.lat)) : [];
  const used = new Set();
  const damRow = (d, text) => {
    if (!d || used.has(d.id)) return;
    used.add(d.id);
    add('#4fa3d9', text, { key: 'alerts', id: `reservoir:${d.id}`, lat: d.lat, lng: d.lng }, `Dam \u00b7 as on ${str(res.date, 12)}`);
  };
  const nearFull = dams.filter((d) => Number.isFinite(d.levelFt) && d.fullFt - d.levelFt <= 5).sort((a, b) => (a.fullFt - a.levelFt) - (b.fullFt - b.levelFt))[0];
  if (nearFull) damRow(nearFull, `${nearFull.name}: ${num(nearFull.fullFt - nearFull.levelFt, 1)} ft from full (${num(nearFull.levelFt, 1)} of ${num(nearFull.fullFt, 0)} ft)`);
  const rising = dams.filter((d) => Number.isFinite(d.levelChangeFt) && d.levelChangeFt >= 1).sort((a, b) => b.levelChangeFt - a.levelChangeFt)[0];
  if (rising) damRow(rising, `${rising.name}: +${num(rising.levelChangeFt, 1)} ft in a day, inflow ${fmtInt(rising.inflow || 0)} cusecs`);
  const inflow = dams.filter((d) => Number.isFinite(d.inflow) && d.inflow >= 5000).sort((a, b) => b.inflow - a.inflow)[0];
  if (inflow) damRow(inflow, `${inflow.name}: inflow ${fmtInt(inflow.inflow)} cusecs, outflow ${fmtInt(inflow.outflow || 0)}`);

  const rivers = (lastBackend && lastBackend.layers && Array.isArray(lastBackend.layers.rivers) ? lastBackend.layers.rivers : [])
    .filter((r) => Number.isFinite(r.peak) && Number.isFinite(r.baseline) && r.baseline > 0 && Number.isFinite(r.lat))
    .map((r) => ({ ...r, ratio: r.peak / r.baseline })).sort((a, b) => b.ratio - a.ratio);
  if (rivers[0] && rivers[0].ratio >= 1.5) {
    const r = rivers[0];
    add('#3d8fb0', `${str(r.name, 60)}: forecast ${num(r.ratio, 1)}x the weekly mean by ${str(r.peakDate, 12)}`, { lat: r.lat, lng: r.lng }, 'River model (GloFAS)');
  }

  const rainList = lastBackend && lastBackend.layers && Array.isArray(lastBackend.layers.rain) ? lastBackend.layers.rain : [];
  const wettest = rainList.filter((r) => r.state === 'Tamil Nadu' || r.state === 'Puducherry').sort((a, b) => (b.next72 || 0) - (a.next72 || 0))[0];
  if (wettest && wettest.next72 >= 30) {
    add(rainColor(wettest.peakMm), `Wettest forecast: ${str(wettest.name, 30)} ${num(wettest.next72, 0)} mm over 3 days (${num(wettest.peakMm, 0)} mm on ${shortDate(wettest.peakDate)})`, { key: 'alerts', id: `rain:${wettest.id}`, lat: wettest.lat, lng: wettest.lng }, 'Rain model, IMD categories');
  }

  const heat = lastBackend && lastBackend.layers && Array.isArray(lastBackend.layers.heat) ? lastBackend.layers.heat : [];
  let hottest = null;
  for (const h of heat) for (const d of (Array.isArray(h.days) ? h.days : []).slice(0, 3)) {
    if (Number.isFinite(d.tmax) && (!hottest || d.tmax > hottest.tmax)) hottest = { ...d, name: h.name, lat: h.lat, lng: h.lng };
  }
  if (hottest && hottest.tmax >= 36) add('#ff9f0a', `Hottest forecast: ${str(hottest.name, 30)} ${num(hottest.tmax, 1)} C on ${str(hottest.date, 12)}`, { lat: hottest.lat, lng: hottest.lng }, 'Forecast');

  /* Cyclones: the poller's tracks (landfall and closest approach) when present, else GDACS points. */
  const storms = (data.cyclones || []).filter((c) => c.kind === 'storm');
  for (const c of storms.slice(0, 2)) {
    const near = c.nearCoast ? `, closest ${fmtInt(c.nearCoast.km)} km off ${c.nearCoast.place}` : '';
    const landfall = c.landfall && Date.parse(c.landfall.at) > Date.now() ? `; landfall near ${c.landfall.near} ${istText(c.landfall.at)}` : '';
    add(GDACS_COLOR[c.alertLevel] || '#f5a623', `Cyclone ${c.name}${near}${landfall}`, { key: 'cyclones', id: c.id }, `GDACS ${c.alertLevel} \u00b7 forecast track`);
  }
  if (!storms.length) {
    for (const e of (data.gdacs || []).filter((g) => /TC|cyclone/i.test(g.type) && haversineKm(TN.lat, TN.lng, g.lat, g.lng) < 2500).slice(0, 2)) {
      add(GDACS_COLOR[e.alertLevel] || '#f5a623', `Cyclone ${e.name} (${e.alertLevel}), ${fmtInt(haversineKm(TN.lat, TN.lng, e.lat, e.lng))} km from central TN`, { key: 'gdacs', id: e.id }, 'GDACS');
    }
  }
  const sea = (data.sea || []).filter((p) => Number.isFinite(p.peakM)).sort((a, b) => b.peakM - a.peakM)[0];
  if (sea && sea.peakM >= 2.5) {
    add(sea.peakM >= 4 ? '#ff9f0a' : '#ffd60a', `${sea.state} sea off ${str(sea.name, 30)}: waves up to ${num(sea.peakM, 1)} m on ${shortDate(sea.peakDate)}`, { key: 'sea', id: sea.id }, 'Wave model, next 48 h');
  }
  const tnFires = (data.fires || []).filter((f) => haversineKm(TN.lat, TN.lng, f.lat, f.lng) < 330);
  if (tnFires.length >= 3) {
    const big = tnFires.reduce((a, b) => ((b.frpMw || 0) > (a.frpMw || 0) ? b : a));
    add('#ff9f0a', `${tnFires.length} fire hotspots in Tamil Nadu in 24 h`, { key: 'fires', id: big.id }, 'NASA FIRMS (VIIRS)');
  }
  const tnNews = (data.news || []).filter((n) => n.state === 'Tamil Nadu' || n.state === 'Puducherry');
  if (tnNews.length) add('#9aa4b2', `${tnNews.length} Tamil Nadu headline${tnNews.length === 1 ? '' : 's'}: ${str(tnNews[0].title, 80)}`, { key: 'news', id: tnNews[0].id }, 'GDELT, unverified');
  const quakes = (data.quakes || []).filter((q) => q.mag >= 4.5 && haversineKm(TN.lat, TN.lng, q.lat, q.lng) < 1500);
  if (quakes.length) {
    const q = quakes.sort((a, b) => b.mag - a.mag)[0];
    add('#e2554a', `${quakes.length} quake${quakes.length === 1 ? '' : 's'} M4.5+ within 1,500 km; largest M${q.mag.toFixed(1)} ${str(q.place, 50)}`, { key: 'quakes', id: q.id }, 'USGS, last 24 h');
  }
  const distress = (data.ships || []).filter((sh) => [2, 6, 14].includes(sh.status) && haversineKm(TN.lat, TN.lng, sh.lat, sh.lng) < 800);
  for (const sh of distress.slice(0, 2)) add(SEV_COLOR.high, `${sh.name || `MMSI ${sh.id}`}: ${AIS_STATUS[sh.status]}`, { key: 'ships', id: sh.id }, 'AIS');
  return rows;
}

export function renderBrief() {
  const el = $('brief');
  if (!el) return;
  appState.briefDirty = false;
  const genMs = lastBackend ? Date.parse(lastBackend.generatedAt) : NaN;
  const ageMs = Date.now() - genMs;
  const age = DEMO ? 'demo data' : Number.isFinite(genMs) ? `updated ${relTime(genMs)}` : 'waiting for poller data';
  const stale = !DEMO && (!Number.isFinite(genMs) || ageMs > BACKEND_STALE_MS);
  const rows = briefRows();
  briefTargets.length = 0;
  el.innerHTML = `
      <div class="brief-head"><span>Tamil Nadu now</span><span class="brief-age${stale ? ' stale' : ''}">${esc(age)}</span></div>
      ${rows.map((r) => {
      const i = r.target ? briefTargets.push(r.target) - 1 : -1;
      return `<button class="brief-row" type="button"${i >= 0 ? ` data-brief="${i}"` : ' disabled'}>
          <span class="dot" style="background:${esc(r.color)}"></span>
          <span class="brief-text">${esc(r.text)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span>
        </button>`;
    }).join('')}`;
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  appState.briefDirty = true;

  $('brief').addEventListener('click', (e) => {
    const row = e.target.closest('[data-brief]');
    if (!row) return;
    const t = briefTargets[Number(row.dataset.brief)];
    if (!t) return;
    const it = t.key ? (data[t.key] || []).find((x) => x.id === t.id || (typeof x.id === 'string' && x.id.startsWith(`${t.id}:`))) : null;
    if (it) {
      flyTo(it.lat, it.lng, RADIUS + 6);
      showItemDetail(t.key, it);
    } else if (Number.isFinite(t.lat)) {
      flyTo(t.lat, t.lng, RADIUS + 6);
    }
  });
  setInterval(() => { if (appState.briefDirty || document.visibilityState === 'visible') renderBrief(); }, 30000);
  setInterval(() => { if (appState.briefDirty) renderBrief(); }, 1500);
}
