/** Alert rules evaluated in the browser, toasts and browser notifications. */
import { appState } from './app-state.js';
import {
  $, EMERGENCY_SQUAWKS, GDACS_LEVEL, GDACS_TYPES, MAX_EVENTS, SEVERITY, SEV_COLOR, esc, haversineKm, num,
  store
} from './core.js';
import { LAYERS } from './layers.js';
import { data, persistSeen, ruleInit, seen, transitionState } from './state.js';
import { updateAlertLayer } from './icons.js';
import { showEventDetail } from './ui/detail.js';
import { renderFeed } from './ui/feed.js';
import { updateRuleCounts } from './ui/rules-panel.js';
import { isCompact, openPanel } from './ui/panels.js';

export const RULE_DEFS = [
  {
    id: 'quake_mag', layer: 'quakes', name: 'Earthquake magnitude',
    description: 'Quake at or above a magnitude threshold.',
    defaultScope: 'zones',
    params: [{ key: 'minMag', label: 'Min magnitude', type: 'number', step: 0.1, default: 4.0 }],
    match: (it, p) => it.mag >= p.minMag,
    key: (it) => it.id,
    severity: (it) => (it.mag >= 6.5 ? 'critical' : it.mag >= 5.5 ? 'high' : 'medium'),
    title: (it) => `M${num(it.mag, 1)} ${it.place}`
  },
  {
    id: 'quake_tsunami', layer: 'quakes', name: 'Tsunami-flagged quake',
    description: 'USGS has set the tsunami flag on the event.',
    defaultScope: 'global', params: [],
    match: (it) => it.tsunami,
    key: (it) => it.id,
    severity: () => 'critical',
    title: (it) => `Tsunami flag: M${num(it.mag, 1)} ${it.place}`
  },
  {
    id: 'gdacs_level', layer: 'gdacs', name: 'GDACS alert level',
    description: 'Disaster with alert level at or above threshold. Re-fires on escalation.',
    defaultScope: 'global',
    params: [{ key: 'minLevel', label: 'Min level', type: 'select', options: ['Green', 'Orange', 'Red'], default: 'Orange' }],
    match: (it, p) => (GDACS_LEVEL[it.alertLevel] ?? 0) >= (GDACS_LEVEL[p.minLevel] ?? 1),
    key: (it) => `${it.id}:${it.alertLevel}`,
    severity: (it) => (it.alertLevel === 'Red' ? 'critical' : it.alertLevel === 'Orange' ? 'high' : 'low'),
    title: (it) => `${GDACS_TYPES[it.type] || it.type} ${it.alertLevel}: ${it.name}`
  },
  {
    id: 'eonet_zone', layer: 'eonet', name: 'New natural event',
    description: 'Any newly opened EONET event (fire, storm, volcano, flood).',
    defaultScope: 'zones', params: [],
    match: () => true,
    key: (it) => it.id,
    severity: () => 'medium',
    title: (it) => `${it.category}: ${it.title}`
  },
  {
    id: 'flight_squawk', layer: 'flights', name: 'Emergency squawk',
    description: 'Transponder code 7500 hijack, 7600 radio failure, 7700 emergency.',
    defaultScope: 'global',
    params: [{ key: 'codes', label: 'Codes', type: 'text', default: EMERGENCY_SQUAWKS.join(',') }],
    match: (it, p) => Boolean(it.squawk) && String(p.codes).split(',').map((c) => c.trim()).includes(it.squawk),
    key: (it) => `${it.id}:${it.squawk}`,
    severity: (it) => (it.squawk === '7500' ? 'critical' : it.squawk === '7700' ? 'high' : 'medium'),
    title: (it) => `Squawk ${it.squawk}: ${it.callsign} (${it.country})`
  },
  {
    id: 'sat_pass', layer: 'satellites', name: 'Satellite overhead pass',
    description: 'Fires when a matching satellite rises above the elevation threshold at the observer.',
    defaultScope: 'global', scopeLocked: true, transition: true,
    params: [
      { key: 'nameFilter', label: 'Name contains', type: 'text', default: 'ISS' },
      { key: 'minElev', label: 'Min elevation deg', type: 'number', step: 1, default: 10 },
      { key: 'observerZone', label: 'Observer', type: 'zone', default: 'z-tn' }
    ],
    match: (it, p) => it.elevDeg !== null && it.elevDeg >= p.minElev &&
      it.name.toUpperCase().includes(String(p.nameFilter).toUpperCase()),
    key: (it) => it.id,
    severity: () => 'low',
    title: (it) => `${it.name} overhead, elev ${num(it.elevDeg, 0)} deg`
  },
  {
    id: 'india_alerts', layer: 'alerts', name: 'India alerts (poller)',
    description: 'Official SACHET warnings (IMD, state authorities) and derived flood / heat signals from the scheduled poller.',
    defaultScope: 'global', scopeLocked: true,
    params: [{ key: 'include', label: 'Include', type: 'select', options: ['Official + derived', 'Official only'], default: 'Official + derived' }],
    match: (it, p) => it.isAlert && (p.include !== 'Official only' || it.origin === 'official'),
    key: (it) => it.alertKey,
    severity: (it) => it.alertSeverity,
    title: (it) => `${it.origin === 'official' ? 'Official' : 'Derived'}: ${it.title}`
  }
];

export const ruleCfg = store.get('rules', {});

export function observerZone() {
  const id = ruleCfg.sat_pass.params.observerZone;
  return appState.zones.find((z) => z.id === id) || appState.zones[0] || null;
}

function zoneContaining(it) {
  return appState.zones.find((z) => z.enabled && haversineKm(z.lat, z.lng, it.lat, it.lng) <= z.radiusKm) || null;
}

export function evaluate(layerKey, items) {
  let created = 0;
  for (const def of RULE_DEFS) {
    if (def.layer !== layerKey) continue;
    const cfg = ruleCfg[def.id];
    if (!cfg.enabled) continue;

    if (def.transition) {
      const prev = transitionState.get(def.id) || new Set();
      const current = new Set();
      for (const it of items) {
        if (!def.match(it, cfg.params)) continue;
        const k = def.key(it);
        current.add(k);
        if (!prev.has(k)) { createEvent(def, it, cfg, null, false); created++; }
      }
      transitionState.set(def.id, current);
      continue;
    }

    const baseline = !ruleInit[def.id];
    for (const it of items) {
      if (!def.match(it, cfg.params)) continue;
      let zone = null;
      if (cfg.scope === 'zones') {
        zone = zoneContaining(it);
        if (!zone) continue;
      }
      const seenKey = `${def.id}|${def.key(it)}`;
      if (seen.has(seenKey)) continue;
      seen.set(seenKey, Date.now());
      createEvent(def, it, cfg, zone, baseline);
      created++;
    }
    ruleInit[def.id] = true;
  }
  store.set('ruleInit', ruleInit);
  if (created) {
    if (appState.events.length > MAX_EVENTS) appState.events.length = MAX_EVENTS;
    persistSeen();
    store.set('events', appState.events);
    renderFeed();
    updateAlertLayer();
    updateRuleCounts();
  }
}

export function reevaluateAll() {
  for (const key of Object.keys(LAYERS)) {
    if (data[key].length) evaluate(key, data[key]);
  }
}

function createEvent(def, it, cfg, zone, baseline) {
  const layer = LAYERS[def.layer];
  const d = layer.describe(it);
  const ev = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    ruleId: def.id, ruleName: def.name, layer: def.layer, kind: layer.label,
    severity: def.severity(it, cfg.params), title: def.title(it), zone: zone ? zone.name : null,
    lat: it.lat, lng: it.lng, altKm: it.altKm || 0, ts: Date.now(), baseline,
    fields: d.fields, url: d.url || null
  };
  appState.events.unshift(ev);
  if (!baseline) {
    appState.unread++;
    notify(ev);
  }
}

function notify(ev) {
  if (SEVERITY[ev.severity] >= SEVERITY.medium) toast(ev);
  if (appState.notifyEnabled && SEVERITY[ev.severity] >= SEVERITY.high && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(`[${ev.severity.toUpperCase()}] ${ev.ruleName}`, { body: ev.title, tag: ev.id });
    } catch { /* notifications unsupported in this context */ }
  }
}

/* Pop-ups: bursts within 400 ms merge into one summary; tap opens the alert (or the feed);
   swipe sideways to dismiss. On phones they sit above the chips, away from the search bar. */
const toastQueue = [];
let toastTimer = null;

export function toast(ev) {
  toastQueue.push(ev);
  if (!toastTimer) toastTimer = setTimeout(flushToasts, 400);
}

function flushToasts() {
  toastTimer = null;
  const batch = toastQueue.splice(0);
  if (!batch.length) return;
  const top = batch.slice().sort((a, b) => (SEVERITY[b.severity] ?? 0) - (SEVERITY[a.severity] ?? 0))[0];
  const isEvent = (e) => e && e.id && Number.isFinite(e.lat);
  if (batch.length === 1) {
    showToast({ severity: top.severity, html: `<b>${esc(String(top.severity).toUpperCase())}</b> ${esc(top.title)}`, onTap: isEvent(top) ? () => showEventDetail(top) : null });
  } else {
    const n = batch.filter(isEvent).length;
    showToast({
      severity: top.severity,
      html: `<b>${batch.length} new</b> ${esc(top.title)}<small>${n ? 'Tap to open the feed' : `and ${batch.length - 1} more`}</small>`,
      onTap: n ? () => { if (isCompact()) openPanel('right'); else $('feed').scrollTop = 0; } : null
    });
  }
}

function showToast({ severity, html, onTap }) {
  const host = $('toasts');
  const el = document.createElement('div');
  el.className = `toast${onTap ? ' tappable' : ''}`;
  el.setAttribute('role', 'status');
  const color = SEV_COLOR[severity] || SEV_COLOR.medium;
  el.innerHTML = `<span class="dot" style="background:${color};color:${color}"></span><span class="toast-text">${html}</span>`;
  host.prepend(el);
  while (host.children.length > (isCompact() ? 2 : 3)) host.lastChild.remove();
  let gone = false;
  const dismiss = (dir = 0) => {
    if (gone) return;
    gone = true;
    if (dir) {
      el.style.transition = 'transform 0.25s var(--ease), opacity 0.25s var(--ease)';
      el.style.transform = `translateX(${dir * 120}%)`;
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 260);
    } else {
      el.classList.add('out');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }
  };
  let startX = null;
  let dx = 0;
  el.addEventListener('pointerdown', (e) => { startX = e.clientX; dx = 0; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', (e) => {
    if (startX === null) return;
    dx = e.clientX - startX;
    el.style.transform = `translateX(${dx}px)`;
    el.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / 220));
  });
  el.addEventListener('pointerup', () => {
    if (startX === null) return;
    startX = null;
    if (Math.abs(dx) > 60) { dismiss(Math.sign(dx)); return; }
    el.style.transform = '';
    el.style.opacity = '';
    if (Math.abs(dx) < 6) {
      if (onTap) onTap();
      dismiss();
    }
  });
  el.addEventListener('pointercancel', () => { startX = null; el.style.transform = ''; el.style.opacity = ''; });
  setTimeout(() => dismiss(), 7000);
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  for (const def of RULE_DEFS) {
    ruleCfg[def.id] = ruleCfg[def.id] || { enabled: true, scope: def.defaultScope, params: {} };
    for (const p of def.params) {
      if (ruleCfg[def.id].params[p.key] === undefined) ruleCfg[def.id].params[p.key] = p.default;
    }
  }
}
