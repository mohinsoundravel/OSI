/** Smart labels, orbit and track paths, day/night shading and the render loop. */
import { appState } from './app-state.js';
import { $, DEMO, EMERGENCY_SQUAWKS, RADIUS, SEV_COLOR, destination, satLibOk } from './core.js';
import { LAYERS } from './layers.js';
import { AIS_STATUS } from './snapshots.js';
import { satCatalog, satrecFor } from './satellites.js';
import { demoSatellites } from './demo.js';
import { data } from './state.js';
import {
  DIRSCALE, LIFT, LIFT_GLSL, MAXOFF, SUN, atmosphere, camera, canvas, globeGroup, latLngToVector3, liftLocal,
  renderer, scene, vectorOnly, withLift
} from './globe.js';
import { NIGHT_STRENGTH } from './weather.js';
import { updateTiles } from './points.js';
import { updateReadout } from './map-controls.js';
import { ATLAS, alertPoints, displayRadius, iconFor, layerObjects, selectorMesh, zoneLines } from './icons.js';
import { alertPolyGroup, placeSelector, selectorBase } from './spots.js';
import { cam, clampLat, hovered, pointers } from './camera.js';
import { isCompact } from './ui/panels.js';

const tagHost = $('tags');
const TAG_POOL = [];
let tagSet = [];
let lastTagPick = 0;

export const SEV_RANK_N = { low: 0, medium: 1, high: 2, critical: 3 };
const clip = (str, n) => (str.length > n ? `${str.slice(0, n - 1)}\u2026` : str);

export function tagText(key, it) {
  switch (key) {
    case 'flights': {
      if (it.squawk && EMERGENCY_SQUAWKS.includes(it.squawk)) return `${it.callsign} \u00b7 SQK ${it.squawk}`;
      const fl = it.onGround ? 'GND' : Number.isFinite(it.baroAltM) ? `FL${String(Math.round(it.baroAltM * 3.28084 / 100)).padStart(3, '0')}` : '';
      const spd = Number.isFinite(it.velocity) && !it.onGround ? `${Math.round(it.velocity * 3.6)} km/h` : '';
      return [it.callsign, fl, spd].filter(Boolean).join(' \u00b7 ');
    }
    case 'satellites': return `${clip((it.name || '').replace(/\s*\(.*?\)/g, ''), 18)} \u00b7 ${Math.round(it.altKm)} km`;
    case 'quakes': return `M${(it.mag || 0).toFixed(1)}${it.tsunami ? ' \u00b7 tsunami' : ''}`;
    case 'gdacs': return clip(`${it.alertLevel} \u00b7 ${it.name}`, 30);
    case 'eonet': return clip(it.title || '', 26);
    case 'webcams': return clip((it.title || '').replace(/\s*\[DEMO\]/, ''), 22);
    case 'live': return clip(`LIVE \u00b7 ${it.channel}`, 26);
    case 'ships': return clip([it.name || `MMSI ${it.id}`, Number.isFinite(it.sog) && it.sog > 0.5 ? `${it.sog.toFixed(0)} kn` : AIS_STATUS[it.status]].filter(Boolean).join(' \u00b7 '), 30);
    case 'alerts': return clip((it.title || '').replace(/^Official: |^Derived: /, ''), 32);
    default: return '';
  }
}

function tagPriority(key, it, zoom) {
  const id = it.id;
  if (appState.selectedRef && appState.selectedRef.key === key && appState.selectedRef.id === id) return 1000;
  if (hovered && hovered.key === key && hovered.id === id) return 900;
  switch (key) {
    case 'alerts':
      if (it.isAlert) return 500 + 50 * (SEV_RANK_N[it.alertSeverity] || 0);
      if (it.id && it.id.startsWith('rain:')) return it.rainPeak >= 64.5 ? 200 : zoom < 140 ? 30 : -1;
      return zoom < 190 ? 60 : -1;
    case 'flights': return it.squawk && EMERGENCY_SQUAWKS.includes(it.squawk) ? 600 : zoom < 210 ? 40 : -1;
    case 'gdacs': return it.alertLevel === 'Red' ? 450 : it.alertLevel === 'Orange' ? 400 : zoom < 230 ? 70 : -1;
    case 'quakes': return it.mag >= 5 ? 300 + it.mag : it.mag >= 3.5 && zoom < 250 ? 100 + it.mag : zoom < 170 ? 20 : -1;
    case 'satellites':
      if (it.cat === 'station' || (!it.cat && /ISS|ZARYA|TIANGONG|CSS/i.test(it.name || ''))) return 350;
      if (it.cat === 'starlink' || it.cat === 'oneweb' || it.valid === false) return -1;
      if (it.cat === 'india') return zoom < 230 ? 90 : -1;
      if (it.cat === 'gnss' || it.cat === 'weather') return zoom < 180 ? 70 : -1;
      return zoom < 130 ? 20 : zoom < 260 && !it.cat ? 80 : -1;
    case 'eonet': return zoom < 260 ? 120 : -1;
    case 'webcams': return zoom < 200 ? 30 : -1;
    case 'live': return zoom < 150 ? 85 : -1;
    case 'ships': return [2, 6, 14].includes(it.status) ? 550 : zoom < 140 ? 35 : -1;
    default: return -1;
  }
}

const tmpV = new THREE.Vector3();
const camDir = new THREE.Vector3();

/** Screen position of item i in a layer, or null if it is behind the globe or off screen. */
function screenPos(key, i) {
  const obj = layerObjects[key];
  const attr = obj && obj.geometry.getAttribute('position');
  if (!attr || i >= attr.count) return null;
  tmpV.fromBufferAttribute(attr, i);
  return projectLocal(tmpV);
}

/** Screen position of a globe-local point after lift, or null if hidden by the globe or off screen. */
export function projectLocal(local) {
  liftLocal(local, tmpV).applyMatrix4(globeGroup.matrixWorld);
  const r = tmpV.length();
  const d = camera.position.length();
  camDir.copy(camera.position).divideScalar(d);
  const cosAng = tmpV.dot(camDir) / r;
  /* Visible while the angle from the eye's ground point is within both horizon angles. */
  const lim = Math.acos(Math.min(1, RADIUS / d)) + Math.acos(Math.min(1, RADIUS / Math.max(r, RADIUS)));
  if (Math.acos(Math.max(-1, Math.min(1, cosAng))) > lim) return null;
  tmpV.project(camera);
  if (tmpV.z > 1) return null;
  const x = (tmpV.x + 1) / 2 * window.innerWidth;
  const y = (1 - tmpV.y) / 2 * window.innerHeight;
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null;
  return { x, y };
}

/* Keep tags out from under panels, the search bar and the chip row. */
let controlsRect = null;
let controlsRectAt = 0;
function overPanels(x, y) {
  const now = performance.now();
  if (now - controlsRectAt > 1000) {
    controlsRect = $('mapControls').getBoundingClientRect();
    controlsRectAt = now;
  }
  if (controlsRect && x > controlsRect.left - 12 && y > controlsRect.top - 12 && y < controlsRect.bottom + 12) return true;
  if (isCompact()) {
    const sheetOpen = $('left').classList.contains('open') || $('right').classList.contains('open');
    return y < 70 || (sheetOpen && y > window.innerHeight * 0.4) || y > window.innerHeight - 130;
  }
  return x < 344 || x > window.innerWidth - 344 || y < 104;
}

function pickTags() {
  const zoom = camera.position.z;
  const candidates = [];
  for (const key of Object.keys(LAYERS)) {
    if (!LAYERS[key].visible || !layerObjects[key]) continue;
    const items = data[key];
    for (let i = 0; i < items.length; i++) {
      const pr = tagPriority(key, items[i], zoom);
      if (pr < 0) continue;
      candidates.push({ key, i, pr });
    }
  }
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const placed = [];
  const max = isCompact() ? 14 : 30;
  const scored = [];
  for (const c of candidates) {
    const p = screenPos(c.key, c.i);
    if (!p || (c.pr < 900 && overPanels(p.x, p.y))) continue;
    scored.push({ ...c, ...p, d: Math.hypot(p.x - cx, p.y - cy) });
  }
  scored.sort((a, b) => b.pr - a.pr || a.d - b.d);
  for (const c of scored) {
    if (placed.length >= max) break;
    const it = data[c.key][c.i];
    const text = tagText(c.key, it);
    if (!text) continue;
    const w = text.length * 6.1 + 26;
    /* Flip to the left of the icon near the right edge so tags never run off screen. */
    const rightLimit = isCompact() ? window.innerWidth - 8 : window.innerWidth - 352;
    const cr = controlsRect;
    const hitsControls = (bx) => cr && bx + w > cr.left - 6 && c.y + 11 > cr.top - 6 && c.y - 11 < cr.bottom + 6;
    let flip = c.x + 14 + w > rightLimit;
    /* Labels flip left rather than run under the map buttons. */
    if (!flip && hitsControls(c.x + 14)) flip = true;
    const box = { x: flip ? c.x - 14 - w : c.x + 14, y: c.y - 11, w, h: 22 };
    if (c.pr < 900 && hitsControls(box.x)) continue;
    /* No room on either side: keep alerts (clamped on screen), drop minor labels. */
    if (box.x < 4) {
      if (c.pr < 400) continue;
      box.x = 4;
    }
    if (c.pr < 900 && placed.some((b) => box.x < b.x + b.w + 4 && box.x + box.w + 4 > b.x && box.y < b.y + b.h + 2 && box.y + box.h + 2 > b.y)) continue;
    placed.push({ ...box, key: c.key, i: c.i, id: it.id, text, pr: c.pr, flip });
  }
  tagSet = placed;

  /* Keep the selection ring on a moving item (satellites, projected flights). */
  if (appState.selectedRef) {
    const it = data[appState.selectedRef.key] && data[appState.selectedRef.key].find((x) => x.id === appState.selectedRef.id);
    if (it) placeSelector(it.lat, it.lng, it.altKm);
  }
}

function renderTags(now) {
  if (appState.tagsDirty || now - lastTagPick > 200) {
    pickTags();
    lastTagPick = now;
    appState.tagsDirty = false;
  }
  while (TAG_POOL.length < tagSet.length) {
    const el = document.createElement('div');
    el.className = 'gtag';
    el.innerHTML = '<span class="ic"></span><span></span>';
    tagHost.appendChild(el);
    TAG_POOL.push(el);
  }
  TAG_POOL.forEach((el, n) => {
    const t = tagSet[n];
    if (!t) {
      el.style.opacity = '0';
      return;
    }
    const items = data[t.key];
    const p = items[t.i] && items[t.i].id === t.id ? screenPos(t.key, t.i) : null;
    if (!p) {
      el.style.opacity = '0';
      return;
    }
    if (el.dataset.text !== t.text) {
      el.dataset.text = t.text;
      el.lastChild.textContent = t.text;
    }
    const icon = iconFor(t.key, items[t.i]).icon;
    if (el.dataset.icon !== icon) {
      el.dataset.icon = icon;
      el.firstChild.style.setProperty('--m', `url(${ATLAS.urls[icon]})`);
    }
    const color = t.key === 'alerts' && items[t.i].alertSeverity ? SEV_COLOR[items[t.i].alertSeverity] : LAYERS[t.key].color;
    el.style.setProperty('--c', color);
    el.classList.toggle('focus', t.pr >= 900);
    const x = Math.max(4, Math.min(window.innerWidth - 4 - el.offsetWidth, t.flip ? p.x - 14 - el.offsetWidth : p.x + 14));
    el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(p.y - 11)}px, 0)`;
    el.style.opacity = '1';
  });
}

/* Selected-item paths: orbit for satellites, projected 30-minute track for flights. */
let pathLine = null;
let pathUpdated = 0;

function clearPath() {
  if (pathLine) {
    globeGroup.remove(pathLine);
    pathLine.geometry.dispose();
    pathLine.material.dispose();
    pathLine = null;
  }
}

function computePath(key, it) {
  const pts = [];
  if (key === 'satellites') {
    const now = Date.now();
    if (DEMO) {
      for (let k = 0; k <= 100; k++) {
        const s = demoSatellites(now + k * 60000).find((x) => x.id === it.id);
        if (s) pts.push(latLngToVector3(s.lat, s.lng, displayRadius(s.altKm)));
      }
    } else if (satLibOk) {
      const rec = satCatalog.find((s) => s.noradId === it.id);
      if (!rec || !satrecFor(rec)) return pts;
      for (let k = 0; k <= 100; k++) {
        const t = new Date(now + k * 60000);
        const pv = satellite.propagate(rec.satrec, t);
        if (!pv || !pv.position || typeof pv.position !== 'object') continue;
        const gd = satellite.eciToGeodetic(pv.position, satellite.gstime(t));
        pts.push(latLngToVector3(satellite.degreesLat(gd.latitude), satellite.degreesLong(gd.longitude), displayRadius(gd.height)));
      }
    }
  } else if (key === 'ships' && it.moving) {
    for (let k = 0; k <= 12; k++) {
      const p = destination(it.lat, it.lng, it.cog, it.sog * 1.852 * (k * 5 / 60));
      pts.push(latLngToVector3(p.lat, p.lng, RADIUS + 0.8));
    }
  } else if (key === 'flights' && !it.onGround && Number.isFinite(it.track) && Number.isFinite(it.velocity)) {
    const r = displayRadius(it.altKm);
    for (let k = 0; k <= 30; k++) {
      const p = destination(it.lat, it.lng, it.track, (it.velocity * k * 60) / 1000);
      pts.push(latLngToVector3(p.lat, p.lng, r));
    }
  }
  return pts;
}

export function updatePath(force = false) {
  if (!appState.selectedRef || !['satellites', 'flights', 'ships'].includes(appState.selectedRef.key)) {
    clearPath();
    return;
  }
  if (!force && performance.now() - pathUpdated < 20000) return;
  const it = data[appState.selectedRef.key].find((x) => x.id === appState.selectedRef.id);
  clearPath();
  if (!it) return;
  const pts = computePath(appState.selectedRef.key, it);
  if (pts.length < 2) return;
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = withLift(new THREE.LineDashedMaterial({ color: LAYERS[appState.selectedRef.key].color, dashSize: 1.6, gapSize: 1.1, transparent: true, opacity: 0.85, depthWrite: false }));
  pathLine = new THREE.Line(geo, mat);
  pathLine.computeLineDistances();
  globeGroup.add(pathLine);
  pathUpdated = performance.now();
}
let nightMaterial;
let nightMesh;

function updateSun() {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  const dayOfYear = (now.getTime() - start) / 86400000;
  const decl = -23.44 * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
  const hours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  const lng = ((((-15 * (hours - 12)) + 540) % 360) - 180);
  SUN.value.copy(latLngToVector3(decl, lng, 1).normalize());
}

/* Frame-rate independent exponential smoothing factor. */
const smooth = (rate, dt) => 1 - Math.exp(-rate * dt);

let lastFrame = performance.now();
let firstFrame = true;

export function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  const dragging = pointers.size > 0;

  if (cam.fly) {
    const f = smooth(4.2, dt);
    globeGroup.rotation.x += (cam.fly.x - globeGroup.rotation.x) * f;
    globeGroup.rotation.y += (cam.fly.y - globeGroup.rotation.y) * f;
    if (Math.abs(cam.fly.x - globeGroup.rotation.x) < 0.0005 && Math.abs(cam.fly.y - globeGroup.rotation.y) < 0.0005) cam.fly = null;
  } else if (!dragging) {
    globeGroup.rotation.y += cam.vy * dt;
    globeGroup.rotation.x = clampLat(globeGroup.rotation.x + cam.vx * dt);
    const decay = Math.exp(-3.4 * dt);
    cam.vx *= decay;
    cam.vy *= decay;
  }

  /* Idle spin only from orbit; close to the ground it would sweep the view away. */
  const idle = !dragging && !cam.fly && now - cam.lastInteraction > cam.idleResumeMs && appState.selectorTargetOpacity === 0
    && camera.position.z - RADIUS > 120;
  cam.autoSpeed += ((idle ? cam.autoMax : 0) - cam.autoSpeed) * smooth(idle ? 0.6 : 6, dt);
  globeGroup.rotation.y += cam.autoSpeed * dt;

  /* Ease altitude in log space: equal time per order of magnitude, orbit to street. */
  const altNow = Math.max(1e-5, camera.position.z - RADIUS);
  const altGoal = Math.max(1e-5, cam.zoomTarget - RADIUS);
  const alt = Math.exp(Math.log(altNow) + (Math.log(altGoal) - Math.log(altNow)) * smooth(7, dt));
  camera.position.z = RADIUS + alt;
  camera.near = Math.max(0.0004, alt * 0.25);
  camera.far = camera.position.z + RADIUS * 1.5;
  camera.updateProjectionMatrix();
  LIFT.value = Math.min(1, 0.3 * alt);
  MAXOFF.value = alt * 0.6;
  DIRSCALE.value = Math.max(0.0005, Math.min(1, alt / 10));
  NIGHT_STRENGTH.value = Math.max(0.35, Math.min(1, alt / 25));
  atmosphere.material.uniforms.uFade.value = Math.max(0, Math.min(1, (camera.position.z - 114) / 20));
  atmosphere.visible = camera.position.z > 114;
  if (pathLine) pathLine.material.scale = Math.min(5000, 230 / alt);

  /* Icons grow a little as you zoom in, like map symbols. */
  const iconScale = Math.max(0.85, Math.min(1.7, 330 / camera.position.z));
  const aspect = window.innerWidth / window.innerHeight;
  for (const obj of Object.values(layerObjects)) {
    const m = obj.material;
    m.opacity += (obj.userData.targetOpacity - m.opacity) * smooth(7, dt);
    if (obj.userData.targetOpacity === 0 && m.opacity < 0.01) obj.visible = false;
    if (m.uniforms) {
      m.uniforms.uOpacity.value = m.opacity;
      m.uniforms.uScale.value = iconScale;
      m.uniforms.uAspect.value = aspect;
      m.uniforms.uPixelRatio.value = renderer.getPixelRatio();
    }
  }
  for (const l of zoneLines) l.material.opacity += (0.6 - l.material.opacity) * smooth(4, dt);
  for (const l of alertPolyGroup.children) l.material.opacity += (0.9 - l.material.opacity) * smooth(4, dt);

  const sm = selectorMesh.material;
  sm.opacity += (appState.selectorTargetOpacity - sm.opacity) * smooth(9, dt);
  selectorMesh.visible = sm.opacity > 0.01;
  /* Keep the selection ring a constant on-screen size at any zoom level. */
  liftLocal(selectorBase, selectorMesh.position);
  tmpV.copy(selectorMesh.position).applyMatrix4(globeGroup.matrixWorld);
  selectorMesh.scale.setScalar((1 + 0.12 * Math.sin(now / 420)) * (tmpV.distanceTo(camera.position) / 230));

  alertPoints.material.size = 22 + 8 * (0.5 + 0.5 * Math.sin(now / 520));

  updateTiles(now);
  renderer.render(scene, camera);
  globeGroup.updateMatrixWorld();
  updateReadout(now);
  renderTags(now);
  updatePath();
  if (firstFrame) {
    firstFrame = false;
    canvas.classList.add('ready');
  }
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  appState.tagsDirty = true;
  appState.selectedRef = null;

  /* Night side shading from the real sun position (subsolar point). */
  nightMaterial = new THREE.ShaderMaterial({
    uniforms: { uSun: SUN, uLift: LIFT, uMaxOff: MAXOFF },
    vertexShader: `${LIFT_GLSL}\n varying vec3 vN; void main(){ vN = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(liftPos(position), 1.0); }`,
    fragmentShader: 'uniform vec3 uSun; varying vec3 vN; void main(){ float d = dot(vN, uSun); float night = smoothstep(0.06, -0.14, d); gl_FragColor = vec4(0.0, 0.012, 0.045, night * 0.58); }',
    transparent: true,
    depthWrite: false
  });
  nightMesh = new THREE.Mesh(new THREE.SphereGeometry(RADIUS + 0.1, 96, 64), nightMaterial);
  nightMesh.renderOrder = -1;
  globeGroup.add(nightMesh);
  vectorOnly.push(nightMesh);
  updateSun();
  setInterval(updateSun, 60000);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}
