/** Point sprites, the icon atlas and layer geometry on the GPU. */
import { appState } from './app-state.js';
import { ALERT_WINDOW_MS, EMERGENCY_SQUAWKS, RADIUS, SEV_COLOR, destination, hexToRgb } from './core.js';
import { LAYERS } from './layers.js';
import { SAT_CATS } from './satellites.js';
import { data } from './state.js';
import { DIRSCALE, LIFT, LIFT_GLSL, MAXOFF, globeGroup, latLngToVector3, renderer, withLift } from './globe.js';
import { alertPolyGroup } from './spots.js';

/* ----- Point sprites ----- */

function makeDotTexture(soft) {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  if (soft) {
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.18)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
  } else {
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.62, 'rgba(255,255,255,1)');
    g.addColorStop(0.8, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}
let DOT_TEX;
let GLOW_TEX;

/* ----- Icon atlas: white glyphs with a dark outline, tinted per point in the shader ----- */

const ICON = {
  dot: 0, plane: 1, satellite: 2, quake: 3, cyclone: 4, flood: 5, fire: 6, volcano: 7,
  camera: 8, warning: 9, heat: 10, river: 11, drought: 12, dam: 13, storm: 14, event: 15, ship: 16
};
const ATLAS_GRID = 5;
const ATLAS_CELL = 128;

function drawIcon(ctx, name) {
  const P = (pts) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  };
  const circle = (x, y, r) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
  };
  switch (name) {
    case 'dot': circle(0, 0, 0.55); return 'fill';
    case 'ship':
      /* Hull seen from above, bow up (rotated to the ship's heading in the shader). */
      P([[0, -0.95], [0.32, -0.55], [0.36, 0.75], [0.26, 0.92], [-0.26, 0.92], [-0.36, 0.75], [-0.32, -0.55]]);
      return 'fill';
    case 'plane':
      P([[0, -0.95], [0.11, -0.78], [0.12, -0.3], [0.92, 0.12], [0.92, 0.3], [0.12, 0.1], [0.1, 0.6], [0.38, 0.8], [0.38, 0.93],
        [0, 0.82], [-0.38, 0.93], [-0.38, 0.8], [-0.1, 0.6], [-0.12, 0.1], [-0.92, 0.3], [-0.92, 0.12], [-0.12, -0.3], [-0.11, -0.78]]);
      return 'fill';
    case 'satellite':
      ctx.beginPath();
      ctx.rect(-0.95, -0.22, 0.55, 0.44);
      ctx.rect(0.4, -0.22, 0.55, 0.44);
      ctx.rect(-0.4, -0.045, 0.8, 0.09);
      ctx.moveTo(0, -0.34); ctx.lineTo(0.3, 0); ctx.lineTo(0, 0.34); ctx.lineTo(-0.3, 0); ctx.closePath();
      return 'fill';
    case 'quake':
      ctx.beginPath();
      ctx.arc(0, 0, 0.82, 0, Math.PI * 2);
      ctx.moveTo(0.52, 0); ctx.arc(0, 0, 0.52, 0, Math.PI * 2);
      ctx.moveTo(0.22, 0); ctx.arc(0, 0, 0.22, 0, Math.PI * 2);
      return 'stroke';
    case 'cyclone':
      ctx.beginPath();
      ctx.arc(0, 0, 0.2, 0, Math.PI * 2);
      ctx.moveTo(0.2, 0); ctx.bezierCurveTo(0.25, -0.6, -0.35, -0.95, -0.9, -0.55);
      ctx.moveTo(-0.2, 0); ctx.bezierCurveTo(-0.25, 0.6, 0.35, 0.95, 0.9, 0.55);
      return 'stroke';
    case 'flood':
      ctx.beginPath();
      ctx.moveTo(0, -0.95); ctx.bezierCurveTo(0.35, -0.45, 0.62, -0.1, 0.62, 0.25);
      ctx.arc(0, 0.25, 0.62, 0, Math.PI); ctx.bezierCurveTo(-0.62, -0.1, -0.35, -0.45, 0, -0.95);
      return 'fill';
    case 'fire':
      ctx.beginPath();
      ctx.moveTo(0, -0.95); ctx.bezierCurveTo(0.2, -0.5, 0.7, -0.3, 0.62, 0.3);
      ctx.bezierCurveTo(0.58, 0.75, 0.25, 0.92, 0, 0.92); ctx.bezierCurveTo(-0.25, 0.92, -0.62, 0.75, -0.62, 0.3);
      ctx.bezierCurveTo(-0.62, -0.05, -0.35, -0.2, -0.3, -0.5); ctx.bezierCurveTo(-0.1, -0.3, 0, -0.55, 0, -0.95);
      return 'fill';
    case 'volcano':
      P([[-0.92, 0.85], [-0.28, -0.25], [0.28, -0.25], [0.92, 0.85]]);
      ctx.moveTo(-0.05, -0.4); ctx.arc(-0.12, -0.62, 0.2, 0, Math.PI * 2);
      ctx.moveTo(0.42, -0.72); ctx.arc(0.25, -0.72, 0.17, 0, Math.PI * 2);
      return 'fill';
    case 'camera':
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(-0.9, -0.45, 1.8, 1.25, 0.18) : ctx.rect(-0.9, -0.45, 1.8, 1.25);
      ctx.rect(-0.3, -0.7, 0.6, 0.3);
      return 'fill-hole-camera';
    case 'warning':
      P([[0, -0.92], [0.98, 0.82], [-0.98, 0.82]]);
      return 'fill-hole-warning';
    case 'heat':
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(-0.18, -0.92, 0.36, 1.2, 0.18) : ctx.rect(-0.18, -0.92, 0.36, 1.2);
      ctx.moveTo(0.38, 0.52); ctx.arc(0, 0.52, 0.38, 0, Math.PI * 2);
      return 'fill';
    case 'river':
      ctx.beginPath();
      for (const y of [-0.5, 0, 0.5]) {
        ctx.moveTo(-0.9, y);
        ctx.bezierCurveTo(-0.45, y - 0.3, -0.45, y + 0.3, 0, y);
        ctx.bezierCurveTo(0.45, y - 0.3, 0.45, y + 0.3, 0.9, y);
      }
      return 'stroke';
    case 'drought':
      ctx.beginPath();
      ctx.arc(0, 0, 0.42, 0, Math.PI * 2);
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        ctx.moveTo(Math.cos(a) * 0.62, Math.sin(a) * 0.62);
        ctx.lineTo(Math.cos(a) * 0.92, Math.sin(a) * 0.92);
      }
      return 'fill-stroke';
    case 'dam':
      P([[-0.95, -0.75], [-0.15, -0.75], [0.15, 0.85], [-0.95, 0.85]]);
      ctx.moveTo(0.35, -0.35); ctx.lineTo(0.95, -0.35); ctx.moveTo(0.42, 0.05); ctx.lineTo(0.95, 0.05);
      ctx.moveTo(0.5, 0.45); ctx.lineTo(0.95, 0.45);
      return 'fill-stroke';
    case 'storm':
      ctx.beginPath();
      ctx.arc(-0.35, -0.2, 0.38, Math.PI * 0.5, Math.PI * 1.6);
      ctx.arc(0.1, -0.42, 0.42, Math.PI * 1.05, Math.PI * 1.95);
      ctx.arc(0.5, -0.12, 0.35, Math.PI * 1.4, Math.PI * 0.5);
      ctx.closePath();
      ctx.moveTo(0.05, 0.2); ctx.lineTo(-0.25, 0.62); ctx.lineTo(0.02, 0.62); ctx.lineTo(-0.15, 0.98); ctx.lineTo(0.32, 0.45); ctx.lineTo(0.05, 0.45); ctx.lineTo(0.2, 0.2); ctx.closePath();
      return 'fill';
    default:
      P([[0, -0.9], [0.75, 0], [0, 0.9], [-0.75, 0]]);
      return 'fill';
  }
}

function buildIconAtlas() {
  const size = ATLAS_GRID * ATLAS_CELL;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const urls = {};
  for (const [name, index] of Object.entries(ICON)) {
    const col = index % ATLAS_GRID;
    const row = Math.floor(index / ATLAS_GRID);
    ctx.save();
    ctx.translate(col * ATLAS_CELL + ATLAS_CELL / 2, row * ATLAS_CELL + ATLAS_CELL / 2);
    ctx.scale(ATLAS_CELL * 0.4, ATLAS_CELL * 0.4);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const mode = drawIcon(ctx, name);
    const strokeOnly = mode === 'stroke';
    /* Dark halo first for contrast on any background, then the white glyph. */
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.lineWidth = strokeOnly ? 0.42 : 0.26;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    if (strokeOnly) {
      ctx.lineWidth = 0.17;
      ctx.stroke();
    } else {
      ctx.fill('nonzero');
      if (mode === 'fill-stroke') {
        ctx.lineWidth = 0.16;
        ctx.stroke();
      }
    }
    if (mode === 'fill-hole-warning' || mode === 'fill-hole-camera') {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
      ctx.beginPath();
      if (mode === 'fill-hole-warning') {
        ctx.rect(-0.08, -0.32, 0.16, 0.6);
        ctx.rect(-0.08, 0.42, 0.16, 0.16);
      } else {
        ctx.arc(0, 0.17, 0.34, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.restore();

    /* Small standalone copy of each glyph for HTML (legend, chips, tags). */
    const one = document.createElement('canvas');
    one.width = 48;
    one.height = 48;
    one.getContext('2d').drawImage(c, col * ATLAS_CELL, row * ATLAS_CELL, ATLAS_CELL, ATLAS_CELL, 0, 0, 48, 48);
    urls[name] = one.toDataURL('image/png');
  }
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return { tex, urls };
}
export let ATLAS;
let ICON_VERTEX;

const ICON_FRAGMENT = `
    uniform sampler2D uAtlas;
    uniform float uOpacity;
    varying vec3 vColor;
    varying float vIcon;
    varying float vAngle;
    void main() {
      vec2 p = gl_PointCoord - 0.5;
      vec2 q = vec2(p.x, -p.y);
      float c = cos(-vAngle);
      float s = sin(-vAngle);
      vec2 t = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
      vec2 local = vec2(t.x, -t.y) + 0.5;
      if (local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0) discard;
      float col = mod(vIcon, ${ATLAS_GRID.toFixed(1)});
      float row = floor(vIcon / ${ATLAS_GRID.toFixed(1)} + 0.001);
      vec4 tex = texture2D(uAtlas, (vec2(col, row) + local) / ${ATLAS_GRID.toFixed(1)});
      if (tex.a < 0.06) discard;
      gl_FragColor = vec4(vColor * tex.rgb, tex.a * uOpacity);
    }`;

function makeIconMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: ATLAS.tex },
      uOpacity: { value: 0 },
      uScale: { value: 1 },
      uPixelRatio: { value: renderer.getPixelRatio() },
      uAspect: { value: window.innerWidth / window.innerHeight },
      uLift: LIFT,
      uMaxOff: MAXOFF,
      uDirScale: DIRSCALE
    },
    vertexShader: ICON_VERTEX,
    fragmentShader: ICON_FRAGMENT,
    transparent: true,
    depthWrite: false
  });
}

export const LAYER_ICON = { flights: 'plane', quakes: 'quake', gdacs: 'cyclone', eonet: 'fire', satellites: 'satellite', webcams: 'camera', live: 'camera', ships: 'ship', alerts: 'warning' };
const GDACS_ICON = { 'Tropical cyclone': 'cyclone', Flood: 'flood', Earthquake: 'quake', Volcano: 'volcano', Drought: 'drought', Wildfire: 'fire', TC: 'cyclone', FL: 'flood', EQ: 'quake', VO: 'volcano', DR: 'drought', WF: 'fire' };
const EONET_ICON = { Wildfires: 'fire', 'Severe Storms': 'storm', Volcanoes: 'volcano', Floods: 'flood', Drought: 'drought', Earthquakes: 'quake' };
const ALERT_ICON = { dam: 'dam', flood: 'flood', heat: 'heat', cyclone: 'cyclone', rain: 'storm', thunderstorm: 'storm', tsunami: 'warning', earthquake: 'quake' };

/** Icon, on-screen size (CSS px) and whether the icon turns with the item's heading. */
export function iconFor(key, it) {
  switch (key) {
    case 'flights':
      return it.onGround ? { icon: 'dot', size: 6 } : { icon: 'plane', size: it.squawk && EMERGENCY_SQUAWKS.includes(it.squawk) ? 22 : 15, heading: it.track };
    case 'satellites': {
      if (it.cat && SAT_CATS[it.cat]) return { icon: SAT_CATS[it.cat].icon, size: SAT_CATS[it.cat].size };
      return { icon: 'satellite', size: /ISS|ZARYA|TIANGONG|CSS/i.test(it.name || '') ? 24 : 18 };
    }
    case 'quakes': return { icon: 'quake', size: Math.max(10, Math.min(34, 6 + (it.mag || 0) * 4)) };
    case 'gdacs': return { icon: GDACS_ICON[it.type] || 'event', size: it.alertLevel === 'Red' ? 28 : it.alertLevel === 'Orange' ? 24 : 18 };
    case 'eonet': return { icon: EONET_ICON[it.category] || 'event', size: 18 };
    case 'webcams': return { icon: 'camera', size: 16 };
    case 'live': return { icon: 'camera', size: 19 };
    case 'ships': {
      const size = Number.isFinite(it.lengthM) ? Math.max(11, Math.min(17, 9 + it.lengthM / 40)) : 12;
      const heading = Number.isFinite(it.heading) ? it.heading : it.moving ? it.cog : undefined;
      return { icon: 'ship', size, heading };
    }
    case 'alerts':
      if (!it.isAlert) {
        if (it.id && it.id.startsWith('reservoir:')) return { icon: 'dam', size: 15 };
        if (it.id && it.id.startsWith('rain:')) return { icon: 'storm', size: Math.round(11 + Math.min(8, (it.rainTotal || 0) / 30)) };
        return { icon: it.id && it.id.startsWith('river:') ? 'river' : 'heat', size: 13 };
      }
      return { icon: ALERT_ICON[it.kind] || 'warning', size: it.alertSeverity === 'critical' ? 30 : it.alertSeverity === 'high' ? 26 : 22 };
    default: return { icon: 'dot', size: 10 };
  }
}

export const selectorMesh = new THREE.Mesh(
  new THREE.RingGeometry(2.6, 3.3, 48),
  new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0, depthWrite: false })
);
export const Z_AXIS = new THREE.Vector3(0, 0, 1);

/* Altitude is log-scaled so GPS orbits (~20,000 km) stay on screen next to aircraft (~10 km). */
export const displayRadius = (altKm) => RADIUS * (1 + 0.15 * Math.log10(1 + Math.max(0, altKm || 0) / 100)) + 0.8;

export const layerObjects = {};

export function updateLayer(key) {
  const layer = LAYERS[key];
  const items = data[key];
  const n = items.length;
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const icons = new Float32Array(n);
  const dirs = new Float32Array(n * 3);
  const base = hexToRgb(layer.color);
  items.forEach((it, i) => {
    const r = displayRadius(it.altKm);
    const v = latLngToVector3(it.lat, it.lng, r);
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;
    colors.set(it.color || base, i * 3);
    const look = iconFor(key, it);
    sizes[i] = look.size;
    icons[i] = ICON[look.icon] ?? 0;
    if (Number.isFinite(look.heading)) {
      const ahead = destination(it.lat, it.lng, look.heading, 150);
      const w = latLngToVector3(ahead.lat, ahead.lng, r).sub(v).normalize().multiplyScalar(2);
      dirs[i * 3] = w.x;
      dirs[i * 3 + 1] = w.y;
      dirs[i * 3 + 2] = w.z;
    }
  });
  if (!layerObjects[key]) {
    const obj = new THREE.Points(new THREE.BufferGeometry(), makeIconMaterial());
    obj.userData.targetOpacity = layer.visible ? 1 : 0;
    obj.visible = layer.visible;
    /* Draw order: big event icons under small moving ones. */
    obj.renderOrder = { alerts: 1, gdacs: 2, eonet: 3, quakes: 4, webcams: 5, live: 5, ships: 6, satellites: 6, flights: 7 }[key] || 0;
    layerObjects[key] = obj;
    globeGroup.add(obj);
  }
  const geo = layerObjects[key].geometry;
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aIcon', new THREE.BufferAttribute(icons, 1));
  geo.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
  geo.computeBoundingSphere();
}

export function setLayerVisible(key, visible) {
  LAYERS[key].visible = visible;
  if (key === 'alerts') alertPolyGroup.visible = visible;
  const obj = layerObjects[key];
  if (!obj) return;
  obj.userData.targetOpacity = visible ? 1 : 0;
  if (visible) obj.visible = true;
}

export let alertItems = [];
export let alertPoints;

export function updateAlertLayer() {
  const cutoff = Date.now() - ALERT_WINDOW_MS;
  alertItems = appState.events.filter((e) => !e.baseline && e.ts > cutoff && Number.isFinite(e.lat));
  const positions = new Float32Array(alertItems.length * 3);
  const colors = new Float32Array(alertItems.length * 3);
  alertItems.forEach((e, i) => {
    const v = latLngToVector3(e.lat, e.lng, displayRadius(e.altKm) + 0.5);
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;
    colors.set(hexToRgb(SEV_COLOR[e.severity]), i * 3);
  });
  alertPoints.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  alertPoints.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  alertPoints.geometry.computeBoundingSphere();
}

export let zoneLines = [];
export function updateZoneLines() {
  zoneLines.forEach((l) => { globeGroup.remove(l); l.geometry.dispose(); l.material.dispose(); });
  zoneLines = appState.zones.filter((z) => z.enabled).map((z) => {
    const pts = [];
    for (let b = 0; b <= 360; b += 3) {
      const p = destination(z.lat, z.lng, b, z.radiusKm);
      pts.push(latLngToVector3(p.lat, p.lng, RADIUS + 0.45));
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      withLift(new THREE.LineBasicMaterial({ color: 0x64d2b4, transparent: true, opacity: 0, depthWrite: false }))
    );
    globeGroup.add(line);
    return line;
  });
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  DOT_TEX = makeDotTexture(false);
  GLOW_TEX = makeDotTexture(true);
  ATLAS = buildIconAtlas();

  ICON_VERTEX = `${LIFT_GLSL}
    uniform float uDirScale;
    attribute vec3 aColor;
    attribute float aSize;
    attribute float aIcon;
    attribute vec3 aDir;
    uniform float uScale;
    uniform float uPixelRatio;
    uniform float uAspect;
    varying vec3 vColor;
    varying float vIcon;
    varying float vAngle;
    void main() {
      vec3 pos = liftPos(position);
      vec4 clip = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      gl_Position = clip;
      gl_PointSize = aSize * uScale * uPixelRatio;
      vColor = aColor;
      vIcon = aIcon;
      vAngle = 0.0;
      if (dot(aDir, aDir) > 0.0) {
        /* Screen-space heading: project a point slightly ahead along the track. */
        vec4 clip2 = projectionMatrix * modelViewMatrix * vec4(pos + aDir * uDirScale, 1.0);
        vec2 d = (clip2.xy / clip2.w - clip.xy / clip.w) * vec2(uAspect, 1.0);
        if (dot(d, d) > 1e-12) vAngle = atan(d.y, d.x) - 1.5707963;
      }
    }`;
  globeGroup.add(selectorMesh);
  appState.selectorTargetOpacity = 0;
  alertPoints = new THREE.Points(
    new THREE.BufferGeometry(),
    withLift(new THREE.PointsMaterial({
      size: 26, map: GLOW_TEX, vertexColors: true, sizeAttenuation: false, transparent: true,
      opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending
    }))
  );
  globeGroup.add(alertPoints);
}
