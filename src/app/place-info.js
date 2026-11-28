/** Place information on long-press or right-click. */
import { appState } from './app-state.js';
import { $, RADIUS, esc, getJson, haversineKm, num } from './core.js';
import { lastBackend, str } from './layers.js';
import { data } from './state.js';
import { camera, earthMesh, globeGroup, vector3ToLatLng } from './globe.js';
import { placeSelector } from './spots.js';
import { cam, flyTo, groundAt, pickAt, pointer, raycaster } from './camera.js';
import { renderDetail, showEventDetail, showItemDetail } from './ui/detail.js';
import { setPickMode } from './ui/zones-panel.js';
import { closePanels, isCompact } from './ui/panels.js';
import { districts } from './ui/search.js';

/* ----- Place info (long-press / right-click): nearest district, dam, river point, heat
   station, alerts within 75 km, and current weather from Open-Meteo. ----- */
let placeToken = 0;
const WMO = { 0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 80: 'Showers', 81: 'Showers', 82: 'Violent showers', 95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail' };

export function nearest(list, lat, lng) {
  let best = null;
  for (const p of list) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    const d = haversineKm(lat, lng, p.lat, p.lng);
    if (!best || d < best.d) best = { p, d };
  }
  return best;
}

function placeFields(lat, lng, weatherRows) {
  const L = lastBackend && lastBackend.layers ? lastBackend.layers : {};
  const rows = [['Coordinates', `${lat.toFixed(4)}, ${lng.toFixed(4)}`]];
  const dist = nearest(districts, lat, lng);
  if (dist && dist.d < 120) rows.push(['Nearest district HQ', `${dist.p.name} (${Math.round(dist.d)} km)`]);
  const dam = nearest(L.reservoirs && Array.isArray(L.reservoirs.items) ? L.reservoirs.items : [], lat, lng);
  if (dam && dam.d < 150) rows.push(['Nearest dam', `${str(dam.p.name, 40)} (${Math.round(dam.d)} km): ${num(dam.p.levelFt, 1)} of ${num(dam.p.fullFt, 0)} ft`]);
  const river = nearest(Array.isArray(L.rivers) ? L.rivers : [], lat, lng);
  if (river && river.d < 100) rows.push(['Nearest river point', `${str(river.p.name, 50)} (${Math.round(river.d)} km), forecast peak ${num(river.p.peak, 0)} m3/s`]);
  const rainD = nearest(Array.isArray(L.rain) ? L.rain : [], lat, lng);
  if (rainD && rainD.d < 80) rows.push(['District rain forecast', `${rainD.p.name}: ${num(rainD.p.next72, 0)} mm over 3 days, wettest ${num(rainD.p.peakMm, 0)} mm`]);
  const alerts = (data.alerts || []).filter((a) => a.isAlert && haversineKm(lat, lng, a.lat, a.lng) < 75);
  rows.push(['Alerts within 75 km', alerts.length ? alerts.slice(0, 4).map((a) => `[${a.alertSeverity}] ${a.title}`).join('; ') : 'none']);
  const storms = (data.gdacs || []).filter((g) => haversineKm(lat, lng, g.lat, g.lng) < 500);
  if (storms.length) rows.push(['GDACS within 500 km', storms.slice(0, 3).map((g) => `${g.alertLevel} ${g.name}`).join('; ')]);
  return rows.concat(weatherRows);
}

export async function showPlaceInfo(clientX, clientY) {
  const ll = groundAt(clientX, clientY);
  if (ll) showPlaceAt(ll);
}

export async function showPlaceAt(ll, name = null) {
  const token = ++placeToken;
  appState.selectedRef = null;
  appState.tagsDirty = true;
  const title = name || (() => {
    const d = nearest(districts, ll.lat, ll.lng);
    return d && d.d < 60 ? `Near ${d.p.name}` : 'This spot';
  })();
  const draw = (weatherRows) => {
    renderDetail({ kind: 'Place info', title, fields: placeFields(ll.lat, ll.lng, weatherRows), url: null });
    const actions = document.querySelector('#detail .detail-actions');
    if (actions) {
      actions.insertAdjacentHTML('afterbegin', `<button class="btn" type="button" data-action="add-spot" data-lat="${ll.lat.toFixed(4)}" data-lng="${ll.lng.toFixed(4)}" data-name="${esc(title)}">Add watch spot</button>`);
    }
  };
  placeSelector(ll.lat, ll.lng, 0);
  draw([['Weather now', 'loading\u2026']]);
  try {
    const q = new URLSearchParams({
      latitude: ll.lat.toFixed(4), longitude: ll.lng.toFixed(4), timezone: 'auto', forecast_days: '3',
      current: 'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,weather_code',
      daily: 'precipitation_sum,temperature_2m_max'
    });
    const w = await getJson(`https://api.open-meteo.com/v1/forecast?${q}`);
    if (token !== placeToken) return;
    const c = w.current || {};
    const rain = (w.daily && Array.isArray(w.daily.precipitation_sum) ? w.daily.precipitation_sum : []).map((v) => (Number.isFinite(v) ? `${Math.round(v)}` : '?'));
    const tmax = (w.daily && Array.isArray(w.daily.temperature_2m_max) ? w.daily.temperature_2m_max : []).map((v) => (Number.isFinite(v) ? `${Math.round(v)}` : '?'));
    draw([
      ['Weather now', `${WMO[c.weather_code] || 'n/a'}, ${num(c.temperature_2m, 0)} C, humidity ${num(c.relative_humidity_2m, 0)}%, wind ${num(c.wind_speed_10m, 0)} km/h`],
      ['Rain, next 3 days', rain.length ? `${rain.join(' / ')} mm` : 'n/a'],
      ['Max temperature, next 3 days', tmax.length ? `${tmax.join(' / ')} C` : 'n/a'],
      ['Elevation', Number.isFinite(w.elevation) ? `${Math.round(w.elevation)} m` : 'n/a'],
      ['Weather source', 'Open-Meteo forecast (model)']
    ]);
  } catch (err) {
    if (token === placeToken) draw([['Weather now', `unavailable (${err.message})`]]);
  }
}

export function handleGlobeClick(clientX, clientY) {
  const tapAt = performance.now();
  if (!appState.pickMode && tapAt - appState.lastTap.t < 330 && Math.hypot(clientX - appState.lastTap.x, clientY - appState.lastTap.y) < 32) {
    appState.lastTap.t = 0;
    const ll = groundAt(clientX, clientY);
    if (ll) flyTo(ll.lat, ll.lng, RADIUS + (cam.zoomTarget - RADIUS) * 0.3);
    return;
  }
  appState.lastTap = { t: tapAt, x: clientX, y: clientY };
  if (appState.pickMode) {
    pointer.x = (clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(earthMesh)[0];
    if (!hit) return;
    const ll = vector3ToLatLng(globeGroup.worldToLocal(hit.point.clone()));
    const form = $('zoneForm');
    form.elements.lat.value = ll.lat.toFixed(3);
    form.elements.lng.value = ll.lng.toFixed(3);
    setPickMode(false);
    return;
  }

  const hit = pickAt(clientX, clientY);
  if (hit && hit.alert) showEventDetail(hit.alert);
  else if (hit) showItemDetail(hit.key, hit.it);
  else if (isCompact()) closePanels();
}
