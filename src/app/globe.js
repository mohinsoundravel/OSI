/** three.js scene, globe, graticule and country outlines. */
import { $, DEG, RADIUS, getJson } from './core.js';
import { tileState } from './weather.js';

export const canvas = $('globe');
export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 4000);

export const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
const sun = new THREE.DirectionalLight(0xffffff, 0.55);

export const globeGroup = new THREE.Group();

/* Uniforms shared by many materials. SUN: subsolar direction in globe coordinates.
   LIFT / MAXOFF: markers and lines float above the surface by their display height times
   LIFT, capped at MAXOFF; both shrink as the camera descends so nothing hovers kilometres
   above the imagery or above the camera. DIRSCALE: heading probe length for icons. */
export const SUN = { value: new THREE.Vector3(1, 0, 0) };
export const LIFT = { value: 1 };
export const MAXOFF = { value: 1e9 };
export const DIRSCALE = { value: 1 };
const R_GLSL = RADIUS.toFixed(1);
export const LIFT_GLSL = `
    uniform float uLift;
    uniform float uMaxOff;
    vec3 liftPos(vec3 p) {
      float r = length(p);
      if (r <= ${R_GLSL}) return p;
      float off = min((r - ${R_GLSL}) * uLift, uMaxOff);
      return p * ((${R_GLSL} + off) / r);
    }`;

/** Applies the same lift to built-in materials (lines, points). */
export function withLift(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uLift = LIFT;
    shader.uniforms.uMaxOff = MAXOFF;
    shader.vertexShader = `${LIFT_GLSL}\n${shader.vertexShader}`.replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed = liftPos(transformed);');
  };
  return material;
}

/** CPU copy of liftPos, for picking and tag placement. */
export function liftLocal(src, out) {
  const r = src.length();
  if (r <= RADIUS) return out.copy(src);
  const off = Math.min((r - RADIUS) * LIFT.value, MAXOFF.value);
  return out.copy(src).multiplyScalar((RADIUS + off) / r);
}

export const vectorOnly = [];   /* graticule, coastlines, borders, night shell: shown only without imagery tiles */

const earthMaterial = new THREE.MeshPhongMaterial({ color: 0x0b1626, shininess: 12, specular: 0x14233a });
export const earthMesh = new THREE.Mesh(new THREE.SphereGeometry(RADIUS, 96, 64), earthMaterial);

/* Atmosphere: back-face fresnel shell, additive. */
export const atmosphere = new THREE.Mesh(
  new THREE.SphereGeometry(RADIUS * 1.13, 64, 48),
  new THREE.ShaderMaterial({
    vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    uniforms: { uFade: { value: 1 } },
    fragmentShader: 'uniform float uFade; varying vec3 vN; void main(){ float i = pow(0.62 - dot(vN, vec3(0.0, 0.0, 1.0)), 3.2); gl_FragColor = vec4(0.32, 0.62, 1.0, 1.0) * i * uFade; }',
    side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false
  })
);

export function latLngToVector3(lat, lng, radius) {
  const phi = (90 - lat) * DEG;
  const theta = (lng + 180) * DEG;
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
}

export function vector3ToLatLng(v) {
  const r = v.length();
  const lat = 90 - Math.acos(v.y / r) / DEG;
  let lng = Math.atan2(v.z, -v.x) / DEG - 180;
  if (lng < -180) lng += 360;
  return { lat, lng };
}

/* ----- Countries: land fill texture + coastline/border lines from world-atlas ----- */

const WORLD_URL = 'src/vendor/countries-110m.json';

function buildLandTexture(land) {
  const W = 4096;
  const H = 2048;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const ocean = ctx.createLinearGradient(0, 0, 0, H);
  ocean.addColorStop(0, '#08111e');
  ocean.addColorStop(0.5, '#0a1626');
  ocean.addColorStop(1, '#08111e');
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, W, H);

  const px = (lng) => ((lng + 180) / 360) * W;
  const py = (lat) => ((90 - lat) / 180) * H;
  const polygons = land.features.flatMap((f) =>
    f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates);

  ctx.fillStyle = '#1a2b42';
  for (const offset of [-W, 0, W]) {
    ctx.beginPath();
    for (const poly of polygons) {
      for (const ring of poly) {
        let prevLng = null;
        let shift = 0;
        ring.forEach(([lng, lat], i) => {
          if (prevLng !== null && Math.abs(lng - prevLng) > 180) shift += lng < prevLng ? 360 : -360;
          prevLng = lng;
          const x = px(lng + shift) + offset;
          const y = py(lat);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.closePath();
      }
    }
    ctx.fill('evenodd');
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function buildLines(multiLine, radius, color, opacity) {
  const pts = [];
  for (const line of multiLine.coordinates) {
    for (let i = 1; i < line.length; i++) {
      const [lng1, lat1] = line[i - 1];
      const [lng2, lat2] = line[i];
      if (Math.abs(lng2 - lng1) > 180) continue;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(lng2 - lng1), Math.abs(lat2 - lat1)) / 2));
      for (let k = 0; k < steps; k++) {
        const t0 = k / steps;
        const t1 = (k + 1) / steps;
        pts.push(
          latLngToVector3(lat1 + (lat2 - lat1) * t0, lng1 + (lng2 - lng1) * t0, radius),
          latLngToVector3(lat1 + (lat2 - lat1) * t1, lng1 + (lng2 - lng1) * t1, radius)
        );
      }
    }
  }
  return new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(pts),
    withLift(new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }))
  );
}

export async function loadWorld() {
  if (typeof topojson === 'undefined') throw new Error('topojson-client failed to load');
  const world = await getJson(WORLD_URL);
  earthMaterial.map = buildLandTexture(topojson.feature(world, world.objects.land));
  earthMaterial.color.set(0xffffff);
  earthMaterial.needsUpdate = true;
  for (const line of [
    buildLines(topojson.mesh(world, world.objects.countries, (x, y) => x !== y), RADIUS + 0.18, 0x51677f, 0.55),
    buildLines(topojson.mesh(world, world.objects.land), RADIUS + 0.2, 0x7f9cbd, 0.7)
  ]) {
    line.visible = !tileState.enabled;
    vectorOnly.push(line);
    globeGroup.add(line);
  }
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  camera.position.z = 330;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x03050a, 1);

  scene.add(new THREE.AmbientLight(0x9fb3c8, 0.75));
  sun.position.set(-180, 160, 260);
  scene.add(sun);
  scene.add(globeGroup);
  globeGroup.add(earthMesh);
  scene.add(atmosphere);

  /* Graticule every 30 degrees, very faint. */
  (() => {
    const pts = [];
    const push = (a, b) => pts.push(latLngToVector3(a[0], a[1], RADIUS + 0.12), latLngToVector3(b[0], b[1], RADIUS + 0.12));
    for (let lat = -60; lat <= 60; lat += 30) for (let lng = -180; lng < 180; lng += 3) push([lat, lng], [lat, lng + 3]);
    for (let lng = -180; lng < 180; lng += 30) for (let lat = -84; lat < 84; lat += 3) push([lat, lng], [lat + 3, lng]);
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      withLift(new THREE.LineBasicMaterial({ color: 0x6f8fb5, transparent: true, opacity: 0.07, depthWrite: false }))
    );
    globeGroup.add(grid);
    vectorOnly.push(grid);
  })();
}
