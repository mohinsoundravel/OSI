/** Watch zones, layer data and health, stored events and rule de-duplication state. */
import { appState } from './app-state.js';
import { SEEN_TTL_MS, store } from './core.js';
import { LAYERS } from './layers.js';

const DEFAULT_ZONES = [
  { id: 'z-tn', name: 'Tamil Nadu & coast', lat: 11.0, lng: 78.6, radiusKm: 450, enabled: true },
  { id: 'z-in', name: 'Indian subcontinent', lat: 22.0, lng: 80.0, radiusKm: 2200, enabled: true },
  { id: 'z-io', name: 'Northern Indian Ocean', lat: 8.0, lng: 75.0, radiusKm: 2800, enabled: false }
];
export const data = {};
export const health = {};

export const seen = new Map(Object.entries(store.get('seen', {})).filter(([, ts]) => Date.now() - ts < SEEN_TTL_MS));
export const ruleInit = store.get('ruleInit', {});
export const transitionState = new Map();

export function persistSeen() {
  const cutoff = Date.now() - SEEN_TTL_MS;
  const obj = {};
  for (const [k, ts] of seen) {
    if (ts > cutoff) obj[k] = ts; else seen.delete(k);
  }
  store.set('seen', obj);
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  appState.zones = store.get('zones', DEFAULT_ZONES);
  for (const key of Object.keys(LAYERS)) {
    data[key] = [];
    health[key] = { status: 'idle', lastOk: null, latencyMs: null, failures: 0, error: null, nextAt: null };
  }

  appState.events = store.get('events', []);
  appState.unread = 0;
  appState.notifyEnabled = false;
  appState.pickMode = false;
}
