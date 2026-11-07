/** Source scheduling with backoff, and the satellite update loops. */
import { appState } from './app-state.js';
import { DEMO } from './core.js';
import { LAYERS, backendBase } from './layers.js';
import { projectFlights, projectShips } from './snapshots.js';
import { FETCHERS } from './fetchers.js';
import { propagateNotable, satItems, satWorker, updateSatPositions } from './satellites.js';
import { DEMO_FETCHERS, DEMO_INTERVALS, demoSatellites } from './demo.js';
import { data, health } from './state.js';
import { evaluate } from './rules.js';
import { updateLayer } from './icons.js';
import { checkSpotAlerts, updateAlertPolygons } from './spots.js';
import { BRIEF_SOURCES } from './ui/brief.js';

function schedule(key, delayMs) {
  health[key].nextAt = Date.now() + delayMs;
  setTimeout(() => runSource(key), delayMs);
}

export async function runSource(key) {
  const h = health[key];
  if (h.status === 'idle') h.status = 'loading';
  const t0 = performance.now();
  const interval = DEMO ? DEMO_INTERVALS[key] : key === 'flights' && backendBase() ? 5 * 60 * 1000 : LAYERS[key].intervalMs;
  try {
    const items = await (DEMO ? DEMO_FETCHERS : FETCHERS)[key]();
    h.latencyMs = Math.round(performance.now() - t0);
    h.lastOk = Date.now();
    h.failures = 0;
    h.error = null;
    h.status = items.warning ? 'stale' : 'live';
    if (items.warning) h.error = items.warning;
    data[key] = items;
    updateLayer(key);
    if (key === 'alerts') updateAlertPolygons(items);
    if (BRIEF_SOURCES.has(key)) appState.briefDirty = true;
    if (key === 'alerts') checkSpotAlerts();
    evaluate(key, items);
    schedule(key, interval);
  } catch (err) {
    /* A source waiting for a key or URL is not broken: show it as needing setup, without backoff. */
    if (/no API key|no poller data URL/.test(err.message)) {
      h.status = 'off';
      h.error = err.message;
      h.failures = 0;
      schedule(key, Math.max(interval, 60000));
      return;
    }
    h.failures++;
    h.status = 'error';
    h.error = err.message;
    schedule(key, Math.min(interval * 2 ** h.failures, 600000));
  }
}

/* Satellites are re-propagated at 10 Hz so they glide instead of jumping; rules still run every 2 s. */
let satTick = 0;

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  /* Flights and ships from a snapshot move along their tracks every 5 s between refreshes. */
  setInterval(() => {
    if (!DEMO && appState.flightSnapshot) {
      data.flights = projectFlights();
      updateLayer('flights');
    }
    if (appState.shipSnapshot) {
      data.ships = projectShips();
      updateLayer('ships');
    }
  }, 5000);
  setInterval(() => {
    if (DEMO) {
      const items = demoSatellites();
      data.satellites = items;
      updateLayer('satellites');
      if (++satTick % 20 === 0) evaluate('satellites', items);
    } else if (!satWorker && satItems.length && data.satellites === satItems && ++satTick % 10 === 0) {
      propagateNotable();
      updateLayer('satellites');
    }
  }, 100);
  /* All-satellite mode: interpolate worker keyframes ~30 times a second. */
  setInterval(updateSatPositions, 33);
}
