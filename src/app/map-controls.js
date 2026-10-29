/** Map buttons, eye-altitude readout, imagery credit and the legend. */
import { $, EARTH_KM, GDACS_COLOR, RADIUS, SEV_COLOR, esc } from './core.js';
import { CYCLONE_CLASS, FIRE_COLORS, NEWS_CATEGORY, SEA_COLORS } from './hazards.js';
import { LAYERS, RAIN_CATS } from './layers.js';
import { SAT_CATS } from './satellites.js';
import { camera, globeGroup, vector3ToLatLng } from './globe.js';
import { MAP_STYLES, STYLE_ORDER } from './tiles.js';
import { WEATHER_ORDER, WX, setWeather, tileState, toggleRadarLoop, weather } from './weather.js';
import { camLocal, setMapStyle } from './points.js';
import { touch, zoomBy } from './camera.js';

/* ----- Map controls, eye-altitude readout and imagery credit ----- */

function fmtAltitude(units) {
  const km = units * (EARTH_KM / RADIUS);
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString()} km`;
}

export function renderMapControls() {
  const btn = $('mapStyleBtn');
  if (!btn) return;
  const st = MAP_STYLES[tileState.style];
  btn.textContent = tileState.enabled ? st.label : 'Offline';
  btn.setAttribute('aria-label', `Map style: ${btn.textContent}. Tap to change.`);
  const credits = [tileState.enabled ? (typeof st.credit === 'function' ? st.credit() : st.credit) : 'Natural Earth (offline outlines)'];
  const wbtn = $('weatherBtn');
  if (weather.mode === 'off') {
    wbtn.textContent = 'Weather';
    wbtn.classList.remove('on');
  } else {
    const at = weather.frameMs ? new Date(weather.frameMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '\u2026';
    wbtn.textContent = weather.error ? `${WX[weather.mode].label} \u00b7 error` : `${WX[weather.mode].label} ${at}`;
    wbtn.classList.add('on');
    credits.push(WX[weather.mode].credit);
  }
  wbtn.setAttribute('aria-label', `Weather layer: ${wbtn.textContent}. Tap to change.`);
  const pbtn = $('radarPlayBtn');
  const showPlay = tileState.enabled && weather.mode === 'radar' && weather.frames.length > 1;
  pbtn.hidden = !showPlay;
  if (showPlay) {
    const a = weather.anim;
    pbtn.textContent = !a.playing ? 'Play last hour' : a.missing > 0 ? 'Loading loop\u2026' : 'Pause';
    pbtn.classList.toggle('on', a.playing);
    pbtn.setAttribute('aria-pressed', String(a.playing));
  }
  $('mapCredit').textContent = credits.join(' \u00b7 ');
  if ($('legend') && !$('legend').hidden) renderLegend();
}

let lastReadout = 0;
export function updateReadout(now) {
  if (now - lastReadout < 250) return;
  lastReadout = now;
  camLocal.copy(camera.position);
  globeGroup.worldToLocal(camLocal);
  const ll = vector3ToLatLng(camLocal);
  const lat = `${Math.abs(ll.lat).toFixed(3)}°${ll.lat >= 0 ? 'N' : 'S'}`;
  const lng = `${Math.abs(ll.lng).toFixed(3)}°${ll.lng >= 0 ? 'E' : 'W'}`;
  $('mapReadout').textContent = `Eye ${fmtAltitude(camera.position.z - RADIUS)} · ${lat} ${lng}`;
}
let LEGENDS;
/* RainViewer "Universal Blue" scheme (official colour table, dBZ). */
const RADAR_SCALE = [['#cec087', '10 dBZ', 'drizzle'], ['#00a3e0', '20', 'light'], ['#005588', '30', 'moderate'], ['#ffaa00', '40', 'heavy'], ['#c10000', '50', 'very heavy'], ['#ff77ff', '60+', 'hail or extreme']];
const GIBS_LEGEND = {
  rain: ['https://gibs.earthdata.nasa.gov/legends/GPM_Precipitation_Rate_H.svg', 'Rain rate, NASA GPM IMERG'],
  clouds: ['https://gibs.earthdata.nasa.gov/legends/Clean_Longwave_Infrared_Window_Band_H.svg', 'Cloud-top temperature, Himawari band 13 (only clouds are drawn)']
};

export function renderLegend() {
  const el = $('legend');
  const sections = [];
  if (weather.mode === 'radar') {
    sections.push(`<div class="lg-title">Radar reflectivity (RainViewer)</div><div class="lg-scale">${RADAR_SCALE.map(([c, v, w]) =>
      `<span><i style="background:${c}"></i><b>${v}</b>${esc(w)}</span>`).join('')}</div>`);
  } else if (GIBS_LEGEND[weather.mode]) {
    const [src, title] = GIBS_LEGEND[weather.mode];
    sections.push(`<div class="lg-title">${esc(title)}</div><img class="lg-img" src="${src}" alt="${esc(title)} legend" referrerpolicy="no-referrer">`);
  }
  for (const [key, [title, items]] of Object.entries(LEGENDS)) {
    const layerKey = key === 'rain' ? 'alerts' : key;
    if (!LAYERS[layerKey] || !LAYERS[layerKey].visible) continue;
    sections.push(`<div class="lg-title">${esc(title)}</div><div class="lg-items">${items.map(([c, label]) =>
      `<span><i style="background:${c}"></i>${esc(label)}</span>`).join('')}</div>`);
  }
  el.innerHTML = sections.join('') || '<div class="lg-title">Nothing to explain: every layer is off.</div>';
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  $('mapStyleBtn').addEventListener('click', () => {
    const i = STYLE_ORDER.indexOf(tileState.style);
    setMapStyle(STYLE_ORDER[(i + 1) % STYLE_ORDER.length]);
  });
  $('radarPlayBtn').addEventListener('click', toggleRadarLoop);

  /* ----- Legend: only for what is on screen ----- */
  LEGENDS = {
    rain: ['District rain forecast (IMD categories)', RAIN_CATS.map(([, c, label]) => [c, label])],
    alerts: ['India alerts', [['#7c8594', 'Low'], [SEV_COLOR.medium, 'Medium'], [SEV_COLOR.high, 'High'], [SEV_COLOR.critical, 'Critical'], ['#4fa3d9', 'Dam (daily level)'], ['#3d8fb0', 'River point (model)'], ['#8c6a3e', 'Heat station (forecast)']]],
    flights: ['Flights', [['#7fd8c0', 'Cruising'], ['#ffb454', 'Climbing or descending'], ['#5a6472', 'On the ground'], [SEV_COLOR.critical, 'Emergency squawk']]],
    ships: ['Ships', [['#6fd08c', 'Cargo'], ['#ff7a6b', 'Tanker'], ['#5ac8fa', 'Passenger'], ['#f5b14c', 'Fishing'], ['#d7a6ff', 'Military or rescue'], ['#b8c2cc', 'Other or unknown'], [SEV_COLOR.high, 'Aground, not under command, AIS-SART']]],
    quakes: ['Earthquakes (size = magnitude)', [['#7a3a36', 'Below M3'], ['#e2554a', 'M3 to M5'], ['#ff4d5e', 'M5 and above']]],
    gdacs: ['GDACS', [[GDACS_COLOR.Green, 'Green'], [GDACS_COLOR.Orange, 'Orange'], [GDACS_COLOR.Red, 'Red']]],
    satellites: ['Satellites (all active)', Object.values(SAT_CATS).map((c) => [c.color, c.label])],
    cyclones: ['Cyclones (dashed: forecast track; white dashed: uncertainty cone; red: 120 km/h winds)',
      [[GDACS_COLOR.Green, 'GDACS Green'], [GDACS_COLOR.Orange, 'GDACS Orange'], [GDACS_COLOR.Red, 'GDACS Red'],
        ...Object.values(CYCLONE_CLASS).slice(0, 3).map(([label, color]) => [color, `Track point: ${label.toLowerCase()}`])]],
    sea: ['Sea state, highest wave in 48 h (WMO)', SEA_COLORS.map(([, c, label]) => [c, label])],
    fires: ['Fire hotspots, 24 h (radiative power)', FIRE_COLORS.map(([, c, label]) => [c, label])],
    news: ['News headlines (unverified)', Object.values(NEWS_CATEGORY).map(([label, c]) => [c, label])]
  };
  $('legendBtn').addEventListener('click', () => {
    const el = $('legend');
    const open = el.hidden;
    if (open) renderLegend();
    el.hidden = !open;
    $('legendBtn').classList.toggle('on', open);
  });
  $('weatherBtn').addEventListener('click', () => {
    const i = WEATHER_ORDER.indexOf(weather.mode);
    setWeather(WEATHER_ORDER[(i + 1) % WEATHER_ORDER.length]);
  });
  $('zoomInBtn').addEventListener('click', () => { touch(); zoomBy(0.4); });
  $('zoomOutBtn').addEventListener('click', () => { touch(); zoomBy(2.5); });
}
