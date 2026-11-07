/** Start-up: initial render, service worker and first source runs. */
import { $, DEG, DEMO } from './core.js';
import { LAYERS } from './layers.js';
import { toast } from './rules.js';
import { globeGroup, loadWorld } from './globe.js';
import { setWeather, weather } from './weather.js';
import { setTilesEnabled } from './points.js';
import { updateAlertLayer, updateZoneLines } from './icons.js';
import { updateSpotLines } from './spots.js';
import { animate } from './tags.js';
import { renderFeed } from './ui/feed.js';
import { renderKeyBox, renderSources } from './ui/sources.js';
import { renderRules } from './ui/rules-panel.js';
import { renderZones } from './ui/zones-panel.js';
import { buildChips, isCompact, syncChips } from './ui/panels.js';
import { renderBrief } from './ui/brief.js';
import { syncViews, updateStatus } from './ui/views.js';
import { runSource } from './scheduler.js';

const setSearchPlaceholder = () => { $('search').placeholder = isCompact() ? 'Search' : 'Search flight, satellite, district'; };

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  globeGroup.rotation.y = Math.PI / 2 - (80 + 180) * DEG;
  globeGroup.rotation.x = 18 * DEG;

  $('modeBtn').textContent = DEMO ? 'Live' : 'Demo';
  $('modeBtn').title = DEMO ? 'Switch to live data' : 'Load synthetic demo data';
  $('modeBtn').addEventListener('click', () => {
    const url = new URL(location.href);
    url.hash = DEMO ? '' : 'demo';
    url.searchParams.delete('demo');
    location.replace(url.toString());
    location.reload();
  });
  if (DEMO) {
    $('demoPill').hidden = false;
    setTimeout(() => toast({ severity: 'medium', title: 'Demo mode: synthetic data, not real events.' }), 900);
  }

  updateZoneLines();
  updateAlertLayer();
  renderSources();
  buildChips();
  syncChips();
  syncViews();
  updateSpotLines();
  renderBrief();
  setSearchPlaceholder();
  window.addEventListener('resize', setSearchPlaceholder);
  updateStatus();
  if (DEMO) {
    $('keyBox').innerHTML = '<div class="note">Demo mode: webcam points are synthetic and carry no images. Switch to live and add a Windy key for real feeds.</div>';
  } else {
    renderKeyBox();
  }
  renderRules();
  renderZones();
  renderFeed();
  requestAnimationFrame(animate);
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('booted')));

  setTilesEnabled(true);
  /* Home-screen app: offline shell and last-known data (https or localhost only). */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (weather.mode !== 'off') setWeather(weather.mode);
  loadWorld().catch((err) => toast({ severity: 'medium', title: `Country outlines unavailable (${err.message}).` }));
  Object.keys(LAYERS).forEach((key, i) => setTimeout(() => runSource(key), 300 + i * 350));
}
