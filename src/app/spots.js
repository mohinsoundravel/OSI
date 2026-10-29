/** Private watch spots, stored only in this browser. */
import { appState } from './app-state.js';
import { RADIUS, SEV_COLOR, destination, haversineKm, store } from './core.js';
import { str } from './layers.js';
import { data } from './state.js';
import { toast } from './rules.js';
import { globeGroup, latLngToVector3, liftLocal, withLift } from './globe.js';
import { Z_AXIS, displayRadius, selectorMesh } from './icons.js';
import { renderZones } from './ui/zones-panel.js';

/* ----- Private watch spots: stored only in this browser (never in the public repo or poller) ----- */
const MAX_SPOTS = 20;
let spotLines = [];

export function saveSpots() {
  store.set('spots', appState.spots);
  updateSpotLines();
  renderZones();
  appState.briefDirty = true;
}

export function updateSpotLines() {
  spotLines.forEach((l) => { globeGroup.remove(l); l.geometry.dispose(); l.material.dispose(); });
  spotLines = appState.spots.map((sp) => {
    const pts = [];
    for (let b = 0; b <= 360; b += 6) {
      const p = destination(sp.lat, sp.lng, b, sp.radiusKm);
      pts.push(latLngToVector3(p.lat, p.lng, RADIUS + 0.45));
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      withLift(new THREE.LineDashedMaterial({ color: 0xc58af7, dashSize: 0.6, gapSize: 0.4, transparent: true, opacity: 0.85, depthWrite: false }))
    );
    line.computeLineDistances();
    globeGroup.add(line);
    return line;
  });
}

export function addSpot(name, lat, lng) {
  if (appState.spots.length >= MAX_SPOTS) {
    toast({ severity: 'medium', title: `Up to ${MAX_SPOTS} watch spots; delete one in Controls, Zones.` });
    return;
  }
  appState.spots.push({ id: Math.random().toString(36).slice(2, 10), name: str(name, 40) || 'Spot', lat: Math.round(lat * 1e4) / 1e4, lng: Math.round(lng * 1e4) / 1e4, radiusKm: 25 });
  saveSpots();
  toast({ severity: 'low', title: `Watch spot added: ${name}. Stored only in this browser.` });
}

/** Alerts inside a spot's radius; new ones pop up once (remembered across reloads). */
export function spotAlerts(sp) {
  return (data.alerts || []).filter((a) => a.isAlert && Number.isFinite(a.lat) && haversineKm(sp.lat, sp.lng, a.lat, a.lng) <= sp.radiusKm + 15);
}
export function checkSpotAlerts() {
  if (!appState.spots.length) return;
  const seen = new Set(store.get('spotSeen', []));
  let changed = false;
  for (const sp of appState.spots) {
    for (const a of spotAlerts(sp)) {
      const k = `${sp.id}|${a.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      changed = true;
      toast({ severity: a.alertSeverity, title: `Near ${sp.name}: ${a.title}` });
      if (appState.notifyEnabled && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification(`Near ${sp.name}`, { body: a.title, tag: k }); } catch { /* unsupported */ }
      }
    }
  }
  if (changed) store.set('spotSeen', [...seen].slice(-400));
}

/* Outlines of official alert areas (CAP polygons), coloured by severity. */
export const alertPolyGroup = new THREE.Group();

export function updateAlertPolygons(items) {
  for (const child of [...alertPolyGroup.children]) {
    alertPolyGroup.remove(child);
    child.geometry.dispose();
    child.material.dispose();
  }
  for (const it of items) {
    if (!it.polygons || !it.polygons.length) continue;
    const color = new THREE.Color(SEV_COLOR[it.alertSeverity] || '#ff9f0a');
    for (const ring of it.polygons) {
      const pts = ring.map(([lng, lat]) => latLngToVector3(lat, lng, RADIUS + 0.55));
      const line = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(pts),
        withLift(new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }))
      );
      alertPolyGroup.add(line);
    }
  }
}

export const selectorBase = new THREE.Vector3(0, 0, RADIUS + 1);
export function placeSelector(lat, lng, altKm) {
  const v = latLngToVector3(lat, lng, displayRadius(altKm) + 0.3);
  selectorBase.copy(v);
  liftLocal(selectorBase, selectorMesh.position);
  selectorMesh.quaternion.setFromUnitVectors(Z_AXIS, v.clone().normalize());
  appState.selectorTargetOpacity = 0.95;
}
export function hideSelector() { appState.selectorTargetOpacity = 0; }

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  appState.spots = (() => {
    const raw = store.get('spots', []);
    return Array.isArray(raw) ? raw.filter((x) => x && Number.isFinite(x.lat) && Number.isFinite(x.lng)).slice(0, MAX_SPOTS).map((x) => ({
      id: String(x.id || Math.random().toString(36).slice(2)), name: str(x.name, 40) || 'Spot', lat: x.lat, lng: x.lng,
      radiusKm: [10, 25, 50, 100].includes(x.radiusKm) ? x.radiusKm : 25
    })) : [];
  })();
  globeGroup.add(alertPolyGroup);
}
