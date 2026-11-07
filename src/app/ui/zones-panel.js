/** Zones tab and watch-zone editing. */
import { appState } from '../app-state.js';
import { $, RADIUS, esc, store } from '../core.js';
import { ruleInit } from '../state.js';
import { RULE_DEFS, reevaluateAll, ruleCfg } from '../rules.js';
import { canvas } from '../globe.js';
import { updateZoneLines } from '../icons.js';
import { saveSpots } from '../spots.js';
import { flyTo } from '../camera.js';
import { renderRules } from './rules-panel.js';

function resetZoneScopedRules() {
  for (const def of RULE_DEFS) {
    if (ruleCfg[def.id].scope === 'zones') ruleInit[def.id] = false;
  }
  store.set('ruleInit', ruleInit);
}

function saveZones() {
  store.set('zones', appState.zones);
  updateZoneLines();
  resetZoneScopedRules();
  renderZones();
  renderRules();
  reevaluateAll();
}

export function renderZones() {
  const list = appState.zones.map((z) => `
      <div class="zone">
        <input type="checkbox" data-zone-enable="${esc(z.id)}"${z.enabled ? ' checked' : ''}>
        <div class="grow"><div>${esc(z.name)}</div><div class="meta">${z.lat.toFixed(2)}, ${z.lng.toFixed(2)} &middot; r ${z.radiusKm} km</div></div>
        <button class="btn" data-zone-fly="${esc(z.id)}">View</button>
        <button class="btn" data-zone-del="${esc(z.id)}">Del</button>
      </div>`).join('');
  const spotList = appState.spots.map((sp) => `
      <div class="zone">
        <div class="grow"><div>${esc(sp.name)}</div><div class="meta">${sp.lat.toFixed(3)}, ${sp.lng.toFixed(3)}</div></div>
        <select data-spot-radius="${esc(sp.id)}" aria-label="Radius for ${esc(sp.name)}">${[10, 25, 50, 100].map((r) => `<option value="${r}"${r === sp.radiusKm ? ' selected' : ''}>${r} km</option>`).join('')}</select>
        <button class="btn" data-spot-fly="${esc(sp.id)}">View</button>
        <button class="btn" data-spot-del="${esc(sp.id)}">Del</button>
      </div>`).join('');
  $('tab-zones').innerHTML = `
      <div class="section-label">My watch spots</div>
      <div class="note">Private: stored only in this browser, never in the public repo. Long-press (or right-click) the globe and choose Add watch spot. Alerts inside a spot pop up while the dashboard is open; Telegram alerts still use the zones below.</div>
      ${spotList ? `<div class="group">${spotList}</div>` : '<div class="empty">No watch spots yet.</div>'}
      <div class="section-label">Monitoring zones</div>
      <div class="note">Zone-scoped rules fire only for items within an enabled zone (great-circle distance from centre).</div>
      ${list ? `<div class="group">${list}</div>` : '<div class="empty">No zones defined.</div>'}
      <form class="zone-form" id="zoneForm" autocomplete="off">
        <input class="full" name="name" placeholder="Zone name" required maxlength="40">
        <input name="lat" type="number" step="any" min="-90" max="90" placeholder="Latitude" required>
        <input name="lng" type="number" step="any" min="-180" max="180" placeholder="Longitude" required>
        <input name="radius" type="number" min="10" max="6000" placeholder="Radius km" required>
        <button type="button" class="btn${appState.pickMode ? ' on' : ''}" id="pickBtn">${appState.pickMode ? 'Click globe' : 'Pick on globe'}</button>
        <button type="submit" class="btn full">Add zone</button>
      </form>`;
}

export function setPickMode(on) {
  appState.pickMode = on;
  canvas.classList.toggle('picking', on);
  const btn = $('pickBtn');
  if (btn) {
    btn.textContent = on ? 'Click globe' : 'Pick on globe';
    btn.classList.toggle('on', on);
  }
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  $('tab-zones').addEventListener('change', (e) => {
    const sid = e.target.dataset.spotRadius;
    if (sid) {
      const sp = appState.spots.find((x) => x.id === sid);
      if (sp) { sp.radiusKm = Number(e.target.value); saveSpots(); }
      return;
    }
    const id = e.target.dataset.zoneEnable;
    if (!id) return;
    const z = appState.zones.find((x) => x.id === id);
    if (z) { z.enabled = e.target.checked; saveZones(); }
  });

  $('tab-zones').addEventListener('click', (e) => {
    const t = e.target;
    if (t.id === 'pickBtn') { setPickMode(!appState.pickMode); return; }
    if (t.dataset.spotFly) {
      const sp = appState.spots.find((x) => x.id === t.dataset.spotFly);
      if (sp) flyTo(sp.lat, sp.lng, RADIUS + 1.5);
      return;
    }
    if (t.dataset.spotDel) {
      appState.spots = appState.spots.filter((x) => x.id !== t.dataset.spotDel);
      saveSpots();
      return;
    }
    if (t.dataset.zoneFly) {
      const z = appState.zones.find((x) => x.id === t.dataset.zoneFly);
      if (z) flyTo(z.lat, z.lng);
      return;
    }
    if (t.dataset.zoneDel) {
      appState.zones = appState.zones.filter((x) => x.id !== t.dataset.zoneDel);
      if (ruleCfg.sat_pass.params.observerZone === t.dataset.zoneDel && appState.zones[0]) {
        ruleCfg.sat_pass.params.observerZone = appState.zones[0].id;
        store.set('rules', ruleCfg);
      }
      saveZones();
    }
  });

  $('tab-zones').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const zone = {
      id: `z-${Date.now().toString(36)}`, name: f.name.value.trim(),
      lat: Number(f.lat.value), lng: Number(f.lng.value), radiusKm: Number(f.radius.value), enabled: true
    };
    if (!zone.name || !Number.isFinite(zone.lat) || !Number.isFinite(zone.lng) || !(zone.radiusKm > 0)) return;
    appState.zones.push(zone);
    saveZones();
    flyTo(zone.lat, zone.lng);
  });
}
