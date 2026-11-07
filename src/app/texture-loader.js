/** Tile texture cache and loader. */
import { renderer } from './globe.js';
import { TILE_SOURCES, styleBase } from './tiles.js';
import { disposeTileMesh, takeToken, tileState, tiles } from './weather.js';

/* ----- Texture cache and loader ----- */

export const texCache = new Map();
export const wanted = [];
const loading = new Set();
let MAX_ANISO;

export function texEntry(src, t) {
  const id = `${src}|${t.key}`;
  let e = texCache.get(id);
  if (!e) {
    e = { id, src, t, status: 'idle', tex: null, ctrl: null, used: 0, want: -1, prio: 0, fails: 0, retryAt: 0, readyAt: 0 };
    texCache.set(id, e);
  }
  return e;
}

export function want(e, prio) {
  if (e.status !== 'idle' && e.status !== 'loading') return;
  if (e.want !== tileState.frame) {
    e.want = tileState.frame;
    e.prio = prio;
    if (e.status === 'idle') wanted.push(e);
  } else {
    e.prio = Math.min(e.prio, prio);
  }
}

async function decodeTileImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob); } catch { /* fall back to an image element */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadTileTexture(e) {
  e.status = 'loading';
  const ctrl = new AbortController();
  e.ctrl = ctrl;
  loading.add(e);
  try {
    const res = await fetch(TILE_SOURCES[e.src].url(e.t.z, e.t.x, e.t.y), {
      signal: ctrl.signal, mode: 'cors', credentials: 'omit', referrerPolicy: 'strict-origin-when-cross-origin'
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { permanent: res.status === 404 || res.status === 400 });
    const blob = await res.blob();
    let image;
    try {
      image = await decodeTileImage(blob);
    } catch {
      throw Object.assign(new Error('not an image'), { permanent: true });
    }
    const tex = new THREE.Texture(image);
    tex.flipY = false;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = MAX_ANISO;
    tex.needsUpdate = true;
    e.tex = tex;
    e.status = 'ready';
    e.readyAt = performance.now();
    if (e.src === styleBase()) tileState.ok++;
  } catch (err) {
    if (err.name === 'AbortError') {
      e.status = 'idle';
    } else {
      e.fails++;
      e.status = err.permanent || e.fails >= 3 ? 'failed' : 'idle';
      e.retryAt = performance.now() + 2500 * e.fails;
      if (e.src === styleBase()) tileState.failed++;
    }
  } finally {
    e.ctrl = null;
    loading.delete(e);
  }
}

export function pumpTileLoads() {
  const now = performance.now();
  /* Abort requests for tiles that left the view, so panning stays responsive. */
  for (const e of loading) if (tileState.frame - e.want > 90 && e.ctrl) e.ctrl.abort();
  const maxLoads = window.innerWidth <= 900 ? 6 : 10;
  if (loading.size >= maxLoads || !wanted.length) return;
  const queue = wanted.filter((e) => e.status === 'idle' && e.retryAt <= now).sort((a, b) => a.prio - b.prio);
  for (const e of queue) {
    if (loading.size >= maxLoads) break;
    if (!takeToken(e.src)) continue;
    loadTileTexture(e);
  }
}

export function evictTiles() {
  const budget = window.innerWidth <= 900 ? 180 : 360;
  const ready = [];
  for (const e of texCache.values()) if (e.status === 'ready') ready.push(e);
  if (ready.length > budget) {
    ready.sort((a, b) => a.used - b.used);
    for (const e of ready.slice(0, ready.length - budget)) {
      if (e.used >= tileState.frame) break;
      e.tex.dispose();
      if (e.tex.image && typeof e.tex.image.close === 'function') e.tex.image.close();
      e.tex = null;
      e.status = 'idle';
    }
  }
  if (tileState.frame % 240 === 0) {
    for (const t of tiles.values()) if (t.mesh && tileState.frame - t.seen > 600) disposeTileMesh(t);
  }
}

/** Nearest ancestor (or the tile itself) whose texture for src is loaded. */
export function readyTexFor(src, t, maxUp = 30) {
  for (let a = t, up = 0; a && up <= maxUp; a = a.parent, up++) {
    if (a.z < TILE_SOURCES[src].minZ) return null;
    const e = texCache.get(`${src}|${a.key}`);
    if (e && e.status === 'ready') return e;
  }
  return null;
}

export function cropRect(target, from, out) {
  const dz = target.z - from.t.z;
  const n = 2 ** dz;
  return out.set((target.x - from.t.x * n) / n, (target.y - from.t.y * n) / n, 1 / n, 1 / n);
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  MAX_ANISO = Math.min(8, renderer.capabilities.getMaxAnisotropy());
}
