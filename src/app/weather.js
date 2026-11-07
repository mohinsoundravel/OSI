/** Weather overlay: radar, satellite rain estimate and infrared clouds, with the radar loop. */
import { DEG, RADIUS, fetchWithTimeout, getJson, store } from './core.js';
import { toast } from './rules.js';
import { SUN, globeGroup, latLngToVector3 } from './globe.js';
import { MAP_STYLES, TILE_SOURCES, defineSource } from './tiles.js';
import { texCache } from './texture-loader.js';
import { renderMapControls } from './map-controls.js';

/* ----- Weather overlay: radar, satellite rain estimate, infrared clouds -----
   Verified from a GitHub runner (diagnose task): all three send CORS headers.
   RainViewer's free tier is radar only, zoom 7 at most (zoom 8 returns a
   "Zoom Level Not Supported" image) and 100 requests per minute per IP; it
   includes the IMD radars at Chennai, Karaikal, Kochi and Thiruvananthapuram.
   IMERG lags about 5 hours; Himawari about 20-30 minutes. Himawari tiles are
   opaque enhanced-infrared images, so the shader keeps only cloud pixels. */
export const WEATHER_ORDER = ['off', 'radar', 'rain', 'clouds'];
export const WX = {
  radar: { label: 'Radar', maxZ: 7, cloudMode: 0, opacity: 0.85, perMin: 80, credit: 'Radar: RainViewer' },
  rain: { label: 'Rain', maxZ: 6, cloudMode: 0, opacity: 0.9, perMin: 240, credit: 'Rain: NASA GPM IMERG (about 5 h behind)' },
  clouds: { label: 'Clouds', maxZ: 6, cloudMode: 1, opacity: 0.9, perMin: 240, credit: 'Clouds: JMA Himawari-9 infrared via NASA GIBS' }
};
export const weather = {
  mode: WX[store.get('weather', 'off')] ? store.get('weather', 'off') : 'off', src: null, prev: null, frameMs: 0, error: null,
  /* Radar loop: the last hour of frames, played at regional detail (zoom 5 at most) so six
     frames fit RainViewer's 100 requests/minute and a phone's texture memory. */
  frames: [], anim: { playing: false, idx: 0, nextAt: 0, missing: 0 }
};
const ANIM_FRAMES = 6;
export const ANIM_MAX_Z = 5;
const floorMinutes = (ms, step) => Math.floor(ms / (step * 60000)) * step * 60000;
const gibsTime = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

async function refreshWeather() {
  const m = weather.mode;
  if (m === 'off') return;
  let id;
  let url;
  let frameMs;
  if (m === 'radar') {
    const j = await getJson('https://api.rainviewer.com/public/weather-maps.json');
    const past = (j.radar && Array.isArray(j.radar.past) ? j.radar.past : [])
      .filter((f) => f && /^\/[A-Za-z0-9/_-]+$/.test(f.path) && Number.isFinite(Number(f.time)));
    const last = past[past.length - 1];
    if (!last || !/^https:\/\/[a-z0-9.-]+\.rainviewer\.com$/.test(j.host)) throw new Error('unexpected radar index');
    const frameSource = (f) => defineSource(`wx:radar:${f.path}`, {
      url: (z, x, y) => `${j.host}${f.path}/512/${z}/${x}/${y}/2/1_1.png`, minZ: 0, maxZ: WX.radar.maxZ, perMin: WX.radar.perMin
    });
    weather.frames = past.slice(-ANIM_FRAMES).map((f) => ({ id: frameSource(f), ms: Number(f.time) * 1000 }));
    if (weather.anim.idx >= weather.frames.length) weather.anim.idx = weather.frames.length - 1;
    id = `wx:radar:${last.path}`;
    url = TILE_SOURCES[id].url;
    frameMs = Number(last.time) * 1000;
  } else {
    /* Latency varies (IMERG 5-7 h, Himawari 20-60 min), so ask GIBS for its latest frame:
       a "default" tile reports the real time in the CORS-exposed layer-time-actual header. */
    const layer = m === 'rain' ? 'IMERG_Precipitation_Rate_30min' : 'Himawari_AHI_Band13_Clean_Infrared';
    let t = null;
    try {
      const res = await fetchWithTimeout(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/default/GoogleMapsCompatible_Level6/0/0/0.png`, 15000);
      const actual = res.headers.get('layer-time-actual');
      if (actual && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(actual)) t = actual;
      await res.arrayBuffer();
    } catch { /* fall back to an estimate below */ }
    if (!t) t = gibsTime(m === 'rain' ? floorMinutes(Date.now() - 420 * 60000, 30) : floorMinutes(Date.now() - 70 * 60000, 10));
    frameMs = Date.parse(t);
    id = `wx:${m}:${t}`;
    url = (z, x, y) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${t}/GoogleMapsCompatible_Level6/${z}/${y}/${x}.png`;
  }
  if (weather.mode !== m) return;
  defineSource(id, { url, minZ: 0, maxZ: WX[m].maxZ, perMin: WX[m].perMin });
  if (id !== weather.src) {
    weather.prev = weather.src && weather.src.startsWith(`wx:${m}:`) ? weather.src : null;
    weather.src = id;
    dropWeatherTextures();
  }
  weather.frameMs = frameMs;
  weather.error = null;
  renderMapControls();
}

/** Frees textures of weather frames that are neither current nor the fallback. */
function dropWeatherTextures() {
  const keep = new Set([weather.src, weather.prev, ...(weather.mode === 'radar' ? weather.frames.map((f) => f.id) : [])]);
  for (const [key, e] of texCache) {
    if (!e.src.startsWith('wx:') || keep.has(e.src)) continue;
    if (e.ctrl) e.ctrl.abort();
    if (e.tex) {
      e.tex.dispose();
      if (e.tex.image && typeof e.tex.image.close === 'function') e.tex.image.close();
    }
    texCache.delete(key);
  }
  for (const id of Object.keys(TILE_SOURCES)) if (id.startsWith('wx:') && !keep.has(id)) delete TILE_SOURCES[id];
}

export function setWeather(mode) {
  weather.mode = mode;
  weather.src = null;
  weather.prev = null;
  weather.frames = [];
  weather.anim.playing = false;
  weather.error = null;
  store.set('weather', mode);
  dropWeatherTextures();
  renderMapControls();
  refreshWeather().catch((err) => {
    weather.error = err.message;
    renderMapControls();
    toast({ severity: 'medium', title: `${WX[mode] ? WX[mode].label : 'Weather'} layer unavailable (${err.message}).` });
  });
}

/** Steps the radar loop once every frame of the visible area has loaded; holds the latest frame longer. */
export function advanceRadarLoop(now) {
  const a = weather.anim;
  if (!a.playing || weather.mode !== 'radar' || !weather.frames.length) return;
  const loading = a.missing > 0;
  if (loading !== a.wasLoading) {
    a.wasLoading = loading;
    renderMapControls();
  }
  if (loading || now < a.nextAt) return;
  a.idx = (a.idx + 1) % weather.frames.length;
  a.nextAt = now + (a.idx === weather.frames.length - 1 ? 1600 : 700);
  weather.frameMs = weather.frames[a.idx].ms;
  renderMapControls();
}

export function toggleRadarLoop() {
  const a = weather.anim;
  if (weather.mode !== 'radar' || !weather.frames.length) return;
  a.playing = !a.playing;
  a.wasLoading = undefined;
  if (!a.playing) {
    a.idx = weather.frames.length - 1;
    weather.frameMs = weather.frames[a.idx].ms;
  } else {
    a.idx = weather.frames.length - 1;
    a.nextAt = 0;
  }
  renderMapControls();
}

/* Per-source request budget (token bucket), so a quick zoom cannot exceed a provider's rate limit. */
const rateBuckets = new Map();
export function takeToken(src) {
  const def = TILE_SOURCES[src];
  if (!def || !def.perMin) return true;
  const key = src.split(':').slice(0, 2).join(':');
  const now = performance.now();
  let b = rateBuckets.get(key);
  if (!b) {
    b = { tokens: def.perMin / 2, at: now };
    rateBuckets.set(key, b);
  }
  b.tokens = Math.min(def.perMin / 2, b.tokens + ((now - b.at) / 60000) * def.perMin);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** The tile's ancestor at level z (or the root tile when z is above the root level). */
export function ancestorAt(t, z) {
  let a = t;
  while (a.z > z && a.parent) a = a.parent;
  return a;
}

export const TILE_ROOT_Z = 2;
export const SPLIT_PX = 256;
export const FADE_MS = 280;
export const OVERLAY_MAX_OVERZOOM = 3;
export const ALT_MIN_TILES = 0.008;   /* ~500 m eye altitude (100 units = 6,371 km) */
export const ALT_MIN_VECTOR = 40;
export const ALT_MAX = 800;
export let tileState;

const BLANK_TEX = new THREE.DataTexture(new Uint8Array([10, 22, 38, 255]), 1, 1, THREE.RGBAFormat);

const TILE_VERTEX = `
    varying vec2 vUv;
    varying vec3 vN;
    void main() {
      vUv = uv;
      vN = normal;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;

const TILE_FRAGMENT = `
    uniform sampler2D uA;
    uniform vec4 uRectA;
    uniform sampler2D uB;
    uniform vec4 uRectB;
    uniform float uMix;
    uniform sampler2D uO1;
    uniform vec4 uRectO1;
    uniform float uO1On;
    uniform sampler2D uO2;
    uniform vec4 uRectO2;
    uniform float uO2On;
    uniform sampler2D uW;
    uniform vec4 uRectW;
    uniform float uWOn;
    uniform float uWCloud;
    uniform float uWOpacity;
    uniform vec3 uSun;
    uniform float uNight;
    varying vec2 vUv;
    varying vec3 vN;
    void main() {
      vec3 c = texture2D(uA, uRectA.xy + vUv * uRectA.zw).rgb;
      if (uMix > 0.0) c = mix(c, texture2D(uB, uRectB.xy + vUv * uRectB.zw).rgb, uMix);
      if (uO1On > 0.5) { vec4 o = texture2D(uO1, uRectO1.xy + vUv * uRectO1.zw); c = mix(c, o.rgb, o.a); }
      if (uO2On > 0.5) { vec4 o = texture2D(uO2, uRectO2.xy + vUv * uRectO2.zw); c = mix(c, o.rgb, o.a); }
      float night = smoothstep(0.06, -0.14, dot(normalize(vN), uSun)) * uNight;
      c = mix(c, c * vec3(0.3, 0.34, 0.46), night);
      /* Weather goes on after night shading so radar and rain stay readable at night. */
      if (uWOn > 0.5) {
        vec4 w = texture2D(uW, uRectW.xy + vUv * uRectW.zw);
        float a = w.a;
        if (uWCloud > 0.5) {
          /* Enhanced infrared: grey = warm surface or low cloud, colour = cold cloud tops. */
          float hi = max(max(w.r, w.g), w.b);
          float lo = min(min(w.r, w.g), w.b);
          float lum = dot(w.rgb, vec3(0.299, 0.587, 0.114));
          a *= max(smoothstep(0.12, 0.35, hi - lo), smoothstep(0.5, 0.85, lum) * 0.85);
        }
        c = mix(c, w.rgb, a * uWOpacity);
      }
      gl_FragColor = vec4(c, 1.0);
    }`;

export const NIGHT_STRENGTH = { value: 1 };

function makeTileMaterial() {
  const rect = () => ({ value: new THREE.Vector4(0, 0, 1, 1) });
  return new THREE.ShaderMaterial({
    uniforms: {
      uA: { value: BLANK_TEX }, uRectA: rect(),
      uB: { value: BLANK_TEX }, uRectB: rect(), uMix: { value: 0 },
      uO1: { value: BLANK_TEX }, uRectO1: rect(), uO1On: { value: 0 },
      uO2: { value: BLANK_TEX }, uRectO2: rect(), uO2On: { value: 0 },
      uW: { value: BLANK_TEX }, uRectW: rect(), uWOn: { value: 0 }, uWCloud: { value: 0 }, uWOpacity: { value: 0.85 },
      uSun: SUN,
      uNight: NIGHT_STRENGTH
    },
    vertexShader: TILE_VERTEX,
    fragmentShader: TILE_FRAGMENT,
    side: THREE.DoubleSide
  });
}

const tileLat = (z, y) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) / DEG;
const tileLng = (z, x) => (x / 2 ** z) * 360 - 180;

export const tiles = new Map();
export const tileGroup = new THREE.Group();

export function getTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  let t = tiles.get(key);
  if (t) return t;
  const n = 2 ** z;
  const north = y === 0 ? 90 : tileLat(z, y);
  const south = y === n - 1 ? -90 : tileLat(z, y + 1);
  const west = tileLng(z, x);
  const east = tileLng(z, x + 1);
  const centerLat = tileLat(z, y + 0.5);
  const center = latLngToVector3(centerLat, (west + east) / 2, RADIUS);
  let radius = 0;
  for (let a = 0; a <= 4; a++) {
    for (let b = 0; b <= 4; b++) {
      const p = latLngToVector3(north + ((south - north) * a) / 4, west + ((east - west) * b) / 4, RADIUS);
      radius = Math.max(radius, p.distanceTo(center));
    }
  }
  radius *= 1.04;
  t = {
    key, z, x, y, center, radius,
    dir: center.clone().normalize(),
    angRadius: 2 * Math.asin(Math.min(1, radius / (2 * RADIUS))),
    widthUnits: (2 * Math.PI * RADIUS * Math.max(0.03, Math.cos(centerLat * DEG))) / n,
    kids: null, parent: z > TILE_ROOT_Z ? getTile(z - 1, x >> 1, y >> 1) : null,
    mesh: null, seen: 0, fade: null
  };
  tiles.set(key, t);
  return t;
}

export function tileChildren(t) {
  if (!t.kids) {
    const z = t.z + 1;
    t.kids = [getTile(z, 2 * t.x, 2 * t.y), getTile(z, 2 * t.x + 1, 2 * t.y), getTile(z, 2 * t.x, 2 * t.y + 1), getTile(z, 2 * t.x + 1, 2 * t.y + 1)];
  }
  return t.kids;
}

export function buildTileMesh(t) {
  const S = t.z <= 3 ? 32 : 16;
  const n = 2 ** t.z;
  const rows = [];
  if (t.y === 0) rows.push({ lat: 90, v: 0 });
  for (let j = 0; j <= S; j++) rows.push({ lat: tileLat(t.z, t.y + j / S), v: j / S });
  if (t.y === n - 1) rows.push({ lat: -90, v: 1 });
  const cols = S + 1;
  const positions = new Float32Array(rows.length * cols * 3);
  const normals = new Float32Array(rows.length * cols * 3);
  const uvs = new Float32Array(rows.length * cols * 2);
  let k = 0;
  for (const row of rows) {
    for (let i = 0; i <= S; i++) {
      const p = latLngToVector3(row.lat, tileLng(t.z, t.x + i / S), RADIUS);
      normals[k * 3] = p.x / RADIUS;
      normals[k * 3 + 1] = p.y / RADIUS;
      normals[k * 3 + 2] = p.z / RADIUS;
      positions[k * 3] = p.x - t.center.x;
      positions[k * 3 + 1] = p.y - t.center.y;
      positions[k * 3 + 2] = p.z - t.center.z;
      uvs[k * 2] = i / S;
      uvs[k * 2 + 1] = row.v;
      k++;
    }
  }
  const index = [];
  for (let r = 0; r < rows.length - 1; r++) {
    for (let i = 0; i < S; i++) {
      const a = r * cols + i;
      index.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(index);
  const mesh = new THREE.Mesh(geo, makeTileMaterial());
  mesh.position.copy(t.center);
  mesh.frustumCulled = false;
  mesh.renderOrder = -3;
  mesh.visible = false;
  tileGroup.add(mesh);
  t.mesh = mesh;
}

export function disposeTileMesh(t) {
  if (!t.mesh) return;
  tileGroup.remove(t.mesh);
  t.mesh.geometry.dispose();
  t.mesh.material.dispose();
  t.mesh = null;
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  setInterval(() => {
    if (weather.mode !== 'off' && !document.hidden) refreshWeather().catch((err) => { weather.error = err.message; });
  }, 5 * 60000);

  tileState = {
    enabled: true,
    style: MAP_STYLES[store.get('mapStyle', 'hybrid')] ? store.get('mapStyle', 'hybrid') : 'hybrid',
    ok: 0,
    failed: 0,
    frame: 0
  };
  BLANK_TEX.needsUpdate = true;
  globeGroup.add(tileGroup);
}
