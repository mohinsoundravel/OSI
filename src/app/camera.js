/** Camera: inertial drag, eased zoom, pinch, fly-to, picking and idle rotation. */
import { appState } from './app-state.js';
import { DEG, RADIUS } from './core.js';
import { LAYERS } from './layers.js';
import { data } from './state.js';
import { camera, canvas, earthMesh, globeGroup, vector3ToLatLng } from './globe.js';
import { ALT_MAX, ALT_MIN_TILES, ALT_MIN_VECTOR, tileState } from './weather.js';
import { alertItems, alertPoints, layerObjects } from './icons.js';
import { handleGlobeClick, showPlaceInfo } from './place-info.js';
import { projectLocal } from './tags.js';
import { isCompact } from './ui/panels.js';

/* ----- Camera: inertial drag, eased zoom, pinch, spring fly-to, idle auto-rotate ----- */

const LAT_LIMIT = 1.25;
export const cam = {
  zoomTarget: 330, vx: 0, vy: 0, fly: null,
  autoSpeed: 0, lastInteraction: performance.now(), idleResumeMs: 9000, autoMax: 0.045
};
export const pointers = new Map();
let pinchDist = 0;
let dragMoved = false;
let downAt = 0;
let lastMove = 0;
let downPos = { x: 0, y: 0 };

export const clampLat = (x) => Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, x));
const wrapAngle = (a) => ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;

export function touch() { cam.lastInteraction = performance.now(); }

/* Zoom works on eye altitude (distance above the surface), so each wheel notch or pinch
   step feels the same from orbit down to street level. */
export function clampZoom(z) {
  const min = tileState.enabled ? ALT_MIN_TILES : ALT_MIN_VECTOR;
  return RADIUS + Math.max(min, Math.min(ALT_MAX, z - RADIUS));
}
export function zoomBy(factor) {
  cam.zoomTarget = clampZoom(RADIUS + (cam.zoomTarget - RADIUS) * factor);
}

export function flyTo(lat, lng, zoom = null) {
  touch();
  cam.vx = 0;
  cam.vy = 0;
  const targetY = Math.PI / 2 - (lng + 180) * DEG;
  const y = globeGroup.rotation.y + wrapAngle(targetY - globeGroup.rotation.y);
  cam.fly = { x: clampLat(lat * DEG), y };
  if (zoom !== null) cam.zoomTarget = clampZoom(zoom);
  else if (cam.zoomTarget > 300) cam.zoomTarget = 260;
}
let longPressTimer = null;

function endPointer(e) {
  clearTimeout(longPressTimer);
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchDist = 0;
  if (pointers.size === 0) {
    canvas.classList.remove('dragging');
    if (performance.now() - lastMove > 80) { cam.vx = 0; cam.vy = 0; }
    if (!dragMoved && performance.now() - downAt < 450) handleGlobeClick(e.clientX, e.clientY);
  }
}

export const raycaster = new THREE.Raycaster();
export const pointer = new THREE.Vector2();

/** Finds what is under a screen point: an alert halo, a layer item, or nothing.
    Done in screen space so the hit area matches the drawn (lifted) icon at any zoom. */
const pickTmp = new THREE.Vector3();
export function pickAt(clientX, clientY) {
  const reach = isCompact() ? 20 : 13;
  const near = (attr, i, extra) => {
    pickTmp.fromBufferAttribute(attr, i);
    const p = projectLocal(pickTmp);
    if (!p) return Infinity;
    const d = Math.hypot(p.x - clientX, p.y - clientY);
    return d <= reach + extra ? d : Infinity;
  };
  const alertAttr = alertPoints.geometry.getAttribute('position');
  if (alertAttr && LAYERS.alerts.visible) {
    let bestI = -1;
    let bestD = Infinity;
    for (let i = 0; i < alertAttr.count; i++) {
      const d = near(alertAttr, i, 4);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    if (bestI >= 0 && alertItems[bestI]) return { alert: alertItems[bestI] };
  }
  const iconScale = Math.max(0.85, Math.min(1.7, 330 / camera.position.z));
  let best = null;
  for (const [key, obj] of Object.entries(layerObjects)) {
    if (!LAYERS[key].visible) continue;
    const attr = obj.geometry.getAttribute('position');
    const sizes = obj.geometry.getAttribute('aSize');
    if (!attr) continue;
    for (let i = 0; i < attr.count; i++) {
      const d = near(attr, i, sizes ? (sizes.getX(i) * iconScale) / 2 - 8 : 0);
      if (d < Infinity && (!best || d < best.d)) best = { key, i, d };
    }
  }
  if (!best) return null;
  const it = data[best.key][best.i];
  return it ? { key: best.key, it, index: best.i } : null;
}

/* Desktop hover: highlight and tag whatever is under the cursor. */
export let hovered = null;
let hoverPending = false;
export function groundAt(clientX, clientY) {
  pointer.x = (clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(earthMesh)[0];
  return hit ? vector3ToLatLng(globeGroup.worldToLocal(hit.point.clone())) : null;
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already released */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      pinchDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    }
    dragMoved = false;
    downPos = { x: e.clientX, y: e.clientY };
    downAt = performance.now();
    lastMove = downAt;
    cam.vx = 0;
    cam.vy = 0;
    cam.fly = null;
    canvas.classList.add('dragging');
    touch();
    /* Long-press (touch): what is at this spot. Mouse users right-click instead. */
    clearTimeout(longPressTimer);
    if (e.pointerType !== 'mouse' && pointers.size === 1) {
      const x = e.clientX;
      const y = e.clientY;
      longPressTimer = setTimeout(() => {
        if (!dragMoved && pointers.size === 1) {
          if (navigator.vibrate) navigator.vibrate(12);
          showPlaceInfo(x, y);
        }
      }, 550);
    }
  });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showPlaceInfo(e.clientX, e.clientY);
  });

  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const now = performance.now();
    const cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);
    touch();

    if (pointers.size === 2) {
      clearTimeout(longPressTimer);
      const [p1, p2] = [...pointers.values()];
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      if (pinchDist > 0) zoomBy(pinchDist / d);
      pinchDist = d;
      dragMoved = true;
      return;
    }

    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    if (Math.hypot(cur.x - downPos.x, cur.y - downPos.y) > 6) dragMoved = true;
    const k = 0.0042 * ((camera.position.z - RADIUS) / 230);
    globeGroup.rotation.y += dx * k;
    globeGroup.rotation.x = clampLat(globeGroup.rotation.x + dy * k);
    const dt = Math.max(8, now - lastMove) / 1000;
    cam.vy = 0.6 * cam.vy + 0.4 * ((dx * k) / dt);
    cam.vx = 0.6 * cam.vx + 0.4 * ((dy * k) / dt);
    lastMove = now;
  });
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    touch();
    zoomBy(Math.exp(e.deltaY * (e.ctrlKey ? 0.012 : 0.003)));
  }, { passive: false });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || pointers.size || hoverPending) return;
    hoverPending = true;
    const x = e.clientX;
    const y = e.clientY;
    setTimeout(() => {
      hoverPending = false;
      const hit = appState.pickMode ? null : pickAt(x, y);
      const next = hit && hit.key ? { key: hit.key, id: hit.it.id } : null;
      if (JSON.stringify(next) !== JSON.stringify(hovered)) {
        hovered = next;
        appState.tagsDirty = true;
      }
      canvas.style.cursor = hit ? 'pointer' : '';
    }, 40);
  });
  canvas.addEventListener('pointerleave', () => {
    if (hovered) {
      hovered = null;
      appState.tagsDirty = true;
    }
  });

  /* Double tap or double click zooms in on that spot, as in Google Earth. */
  appState.lastTap = { t: 0, x: 0, y: 0 };
}
