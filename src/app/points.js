/** Per-frame tile selection and drawing. */
import { DEG, RADIUS, store } from './core.js';
import { toast } from './rules.js';
import { camera, earthMesh, globeGroup, vectorOnly } from './globe.js';
import { MAP_STYLES, TILE_SOURCES, styleBase } from './tiles.js';
import {
  ANIM_MAX_Z, FADE_MS, OVERLAY_MAX_OVERZOOM, SPLIT_PX, TILE_ROOT_Z, WX, advanceRadarLoop, ancestorAt,
  buildTileMesh, getTile, tileChildren, tileGroup, tileState, tiles, weather
} from './weather.js';
import {
  cropRect, evictTiles, pumpTileLoads, readyTexFor, texCache, texEntry, want, wanted
} from './texture-loader.js';
import { renderMapControls } from './map-controls.js';
import { cam, clampZoom } from './camera.js';

/* ----- Per-frame selection ----- */

const tileFrustum = new THREE.Frustum();
const tileProj = new THREE.Matrix4();
const tileSphere = new THREE.Sphere();
export const camLocal = new THREE.Vector3();
const camLocalDir = new THREE.Vector3();
const tileTmp = new THREE.Vector3();
const tileRoots = [];
let shownTiles = [];
const view = { camDist: 330, horizon: 1, pxPerUnit: 1 };

function tileInView(t) {
  const ang = Math.acos(Math.max(-1, Math.min(1, t.dir.dot(camLocalDir))));
  if (ang - t.angRadius > view.horizon) return false;
  tileTmp.copy(t.center).applyMatrix4(globeGroup.matrixWorld);
  tileSphere.set(tileTmp, t.radius);
  return tileFrustum.intersectsSphere(tileSphere);
}

function tileScreenPx(t) {
  const d = Math.max(camLocal.distanceTo(t.center) - t.radius, (view.camDist - RADIUS) * 0.5, 1e-6);
  return (t.widthUnits / d) * view.pxPerUnit;
}

function selectTiles(t, out, maxZ) {
  if (!tileInView(t)) return;
  t.seen = tileState.frame;
  if (t.z < maxZ && tileScreenPx(t) > SPLIT_PX) {
    for (const k of tileChildren(t)) selectTiles(k, out, maxZ);
    return;
  }
  out.push(t);
}

function bindTile(t, now) {
  const style = MAP_STYLES[tileState.style];
  const baseSrc = styleBase();
  const frame = tileState.frame;
  const dist = camLocal.distanceTo(t.center);
  const rank = dist / (dist + view.camDist);
  const own = texEntry(baseSrc, t);
  if (t.z <= TILE_SOURCES[baseSrc].maxZ) want(own, t.z + rank);
  const best = readyTexFor(baseSrc, t);
  if (own.status !== 'ready' && t.parent && t.parent.z >= TILE_SOURCES[baseSrc].minZ) {
    /* Fetch the parent too: one image covers four tiles, so detail arrives progressively. */
    want(texEntry(baseSrc, t.parent), t.z - 1 + rank);
  }
  if (!best) {
    if (t.mesh) t.mesh.visible = false;
    return;
  }
  if (!t.mesh) buildTileMesh(t);
  const u = t.mesh.material.uniforms;
  best.used = frame;
  if (best === own && t.fade && now - own.readyAt < FADE_MS) {
    t.fade.used = frame;
    u.uA.value = t.fade.tex;
    cropRect(t, t.fade, u.uRectA.value);
    u.uB.value = own.tex;
    u.uRectB.value.set(0, 0, 1, 1);
    u.uMix.value = (now - own.readyAt) / FADE_MS;
  } else {
    u.uA.value = best.tex;
    cropRect(t, best, u.uRectA.value);
    u.uMix.value = 0;
    t.fade = best === own ? null : best;
  }
  if (t.fade && (t.fade.status !== 'ready' || !t.fade.tex)) t.fade = null;

  const slots = [['uO1', 'uRectO1', 'uO1On'], ['uO2', 'uRectO2', 'uO2On']];
  slots.forEach(([tk, rk, on], i) => {
    const src = style.overlays[i];
    u[on].value = 0;
    if (!src) return;
    const def = TILE_SOURCES[src];
    if (t.z < def.minZ) return;
    const target = ancestorAt(t, Math.min(t.z, def.maxZ));
    if (t.z - target.z <= OVERLAY_MAX_OVERZOOM) want(texEntry(src, target), target.z + 0.5 + rank);
    const ov = readyTexFor(src, t, OVERLAY_MAX_OVERZOOM);
    if (!ov) return;
    ov.used = frame;
    u[tk].value = ov.tex;
    cropRect(t, ov, u[rk].value);
    u[on].value = 1;
  });

  u.uWOn.value = 0;
  const anim = weather.anim;
  if (weather.mode === 'radar' && anim.playing && weather.frames.length) {
    const level = Math.max(TILE_ROOT_Z, Math.min(t.z - 1, ANIM_MAX_Z));
    const target = ancestorAt(t, level);
    weather.frames.forEach((f, k) => {
      const e = texEntry(f.id, target);
      if (e.status !== 'ready') {
        want(e, target.z + 0.8 + k * 0.01 + rank);
        if (e.status !== 'failed') anim.missing++;
      }
    });
    const cur = weather.frames[anim.idx];
    const w = readyTexFor(cur.id, t) || readyTexFor(weather.frames[weather.frames.length - 1].id, t);
    for (const f of weather.frames) { const e = texCache.get(`${f.id}|${target.key}`); if (e) e.used = frame; }
    if (w) {
      w.used = frame;
      u.uW.value = w.tex;
      cropRect(t, w, u.uRectW.value);
      u.uWOn.value = 1;
      u.uWCloud.value = 0;
      u.uWOpacity.value = WX.radar.opacity;
    }
    t.mesh.visible = true;
    return;
  }
  const wdef = weather.mode !== 'off' && weather.src ? TILE_SOURCES[weather.src] : null;
  if (wdef) {
    /* One level coarser than the imagery: weather data is coarse (radar uses 512 px tiles),
       and it cuts requests fourfold, which matters under RainViewer's rate limit. */
    const target = ancestorAt(t, Math.max(0, Math.min(t.z - 1, wdef.maxZ)));
    want(texEntry(weather.src, target), target.z + 0.7 + rank);
    const w = readyTexFor(weather.src, t) || (weather.prev && TILE_SOURCES[weather.prev] ? readyTexFor(weather.prev, t) : null);
    if (w) {
      w.used = frame;
      u.uW.value = w.tex;
      cropRect(t, w, u.uRectW.value);
      u.uWOn.value = 1;
      u.uWCloud.value = WX[weather.mode].cloudMode;
      u.uWOpacity.value = WX[weather.mode].opacity;
    }
  }
  t.mesh.visible = true;
}

export function updateTiles(now) {
  if (!tileState.enabled) return;
  tileState.frame++;
  wanted.length = 0;
  camera.updateMatrixWorld();
  globeGroup.updateMatrixWorld();
  tileProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  tileFrustum.setFromProjectionMatrix(tileProj);
  camLocal.copy(camera.position);
  globeGroup.worldToLocal(camLocal);
  view.camDist = camLocal.length();
  camLocalDir.copy(camLocal).normalize();
  view.horizon = Math.acos(Math.min(1, RADIUS / view.camDist));
  view.pxPerUnit = window.innerHeight / 2 / Math.tan((camera.fov * DEG) / 2);

  const maxZ = TILE_SOURCES[styleBase()].maxZ;
  const next = [];
  for (const r of tileRoots) selectTiles(r, next, maxZ);
  const keep = new Set(next);
  for (const t of shownTiles) if (!keep.has(t) && t.mesh) t.mesh.visible = false;
  shownTiles = next;
  weather.anim.missing = 0;
  for (const t of next) bindTile(t, now);
  advanceRadarLoop(now);
  pumpTileLoads();
  evictTiles();

  /* If imagery cannot be reached at all (offline, blocked network), fall back to the vector globe. */
  if (tileState.ok === 0 && tileState.failed >= 16) {
    setTilesEnabled(false);
    toast({ severity: 'medium', title: 'Satellite imagery is unreachable from this network; showing the offline map.' });
  }
}

export function setTilesEnabled(on) {
  tileState.enabled = on;
  tileGroup.visible = on;
  for (const o of vectorOnly) o.visible = !on;
  earthMesh.scale.setScalar(on ? 0.9997 : 1);
  if (!on) for (const t of shownTiles) if (t.mesh) t.mesh.visible = false;
  cam.zoomTarget = clampZoom(cam.zoomTarget);
  renderMapControls();
}

export function setMapStyle(name) {
  if (!MAP_STYLES[name]) return;
  tileState.style = name;
  tileState.ok = 0;
  tileState.failed = 0;
  store.set('mapStyle', name);
  for (const t of tiles.values()) t.fade = null;
  if (!tileState.enabled) setTilesEnabled(true);
  renderMapControls();
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  for (let y = 0; y < 2 ** TILE_ROOT_Z; y++) for (let x = 0; x < 2 ** TILE_ROOT_Z; x++) tileRoots.push(getTile(TILE_ROOT_Z, x, y));
}
