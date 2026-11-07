/** One-tap views and the status pill. */
import { appState } from '../app-state.js';
import { $, RADIUS, store } from '../core.js';
import { LAYERS } from '../layers.js';
import { health } from '../state.js';
import { setWeather, weather } from '../weather.js';
import { alertItems, setLayerVisible } from '../icons.js';
import { flyTo } from '../camera.js';
import { isCompact, openPanel, syncChips } from './panels.js';

export let VIEWS;
let currentView = store.get('view', '');

export function applyView(name) {
  const v = VIEWS[name];
  if (!v) return;
  currentView = name;
  store.set('view', name);
  for (const key of Object.keys(LAYERS)) {
    const on = v.layers.includes(key);
    if (LAYERS[key].visible !== on) setLayerVisible(key, on);
    const box = document.querySelector(`[data-layer="${key}"]`);
    if (box) box.checked = on;
  }
  if (v.weather && weather.mode !== v.weather) setWeather(v.weather);
  if (!v.weather && name === 'airsea' && weather.mode !== 'off') setWeather('off');
  flyTo(v.fly[0], v.fly[1], v.fly[2]);
  appState.tagsDirty = true;
  syncChips();
  syncViews();
}
export function syncViews() {
  document.querySelectorAll('[data-view]').forEach((b) => {
    const on = b.dataset.view === currentView;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}
/* Any manual layer change leaves the preset. */
export function leaveView() {
  if (!currentView) return;
  currentView = '';
  store.set('view', '');
  syncViews();
}

/* ----- Status pill ----- */
export function updateStatus() {
  const keys = Object.keys(LAYERS);
  const configured = keys.filter((k) => health[k].status !== 'off');
  const failing = configured.filter((k) => health[k].status === 'error');
  const stale = configured.filter((k) => health[k].status === 'stale');
  const live = configured.length - failing.length - stale.length;
  const alertsNow = alertItems.length;
  $('statusText').textContent = `${alertsNow ? `${alertsNow} alert${alertsNow === 1 ? '' : 's'}` : 'No new alerts'} \u00b7 ${live}/${configured.length} live`;
  const led = $('statusLed');
  led.classList.toggle('bad', failing.length > configured.length / 2);
  led.classList.toggle('warn', !(failing.length > configured.length / 2) && (failing.length + stale.length) > 0);
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  /* ----- One-tap views: layers, camera and weather in a single tap ----- */
  VIEWS = {
    tn: { label: 'TN Watch', layers: ['alerts', 'cyclones', 'sea', 'fires', 'news', 'quakes', 'gdacs', 'ships', 'webcams', 'live'], fly: [10.9, 78.4, RADIUS + 11], weather: 'radar' },
    airsea: { label: 'Air & Sea', layers: ['flights', 'ships', 'satellites', 'alerts'], fly: [15, 80, RADIUS + 45], weather: null },
    global: { label: 'Global', layers: Object.keys(LAYERS), fly: [18, 79, 330], weather: null }
  };
  $('statusPill').addEventListener('click', () => {
    if (isCompact()) openPanel('right');
    else $('feed').scrollTo({ top: 0, behavior: 'smooth' });
  });
}
