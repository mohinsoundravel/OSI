/** Search over places, layers and OpenStreetMap. */
import { $, RADIUS, esc, getJson } from '../core.js';
import { LAYERS, lastBackend, str } from '../layers.js';
import { data } from '../state.js';
import { ATLAS, iconFor, setLayerVisible } from '../icons.js';
import { flyTo } from '../camera.js';
import { showPlaceAt } from '../place-info.js';
import { tagText } from '../tags.js';
import { showItemDetail } from './detail.js';
import { renderSources } from './sources.js';
import { CHIP_LABEL, activeTab, syncChips } from './panels.js';
import { updateStatus } from './views.js';

/* ----- Search ----- */
const SEARCH_FIELDS = {
  flights: (it) => [it.callsign, it.id, it.country],
  satellites: (it) => [it.name, it.id],
  quakes: (it) => [it.place, `M${(it.mag || 0).toFixed(1)}`],
  gdacs: (it) => [it.name, it.country, it.type],
  eonet: (it) => [it.title, it.category],
  webcams: (it) => [it.title, it.city],
  live: (it) => [it.title, it.channel, it.type, it.where],
  ships: (it) => [it.name, it.id, it.destination, it.callsign],
  alerts: (it) => [it.title, ...(it.districts || [])],
  cyclones: (it) => (it.kind === 'storm' ? [it.name, `cyclone ${it.name}`] : []),
  sea: (it) => [it.name, 'sea state'],
  fires: () => [],
  news: (it) => [it.title, it.place, it.state, it.domain]
};
let searchHits = [];
let searchActive = 0;

/* ----- Places: districts (the poller's gazetteer), dams, river points, heat stations, coordinates ----- */
export let districts = [];

function placeList() {
  const L = lastBackend && lastBackend.layers ? lastBackend.layers : {};
  const dams = (L.reservoirs && Array.isArray(L.reservoirs.items) ? L.reservoirs.items : []).filter((d) => Number.isFinite(d.lat))
    .map((d) => ({ name: str(d.name, 60), sub: `Dam, ${str(d.river, 30) || 'reservoir'}`, lat: d.lat, lng: d.lng, alt: 0.5, icon: 'dam', itemId: `reservoir:${d.id}` }));
  const rivers = (Array.isArray(L.rivers) ? L.rivers : []).filter((r) => Number.isFinite(r.lat))
    .map((r) => ({ name: str(r.name, 60), sub: 'River point (model)', lat: r.lat, lng: r.lng, alt: 0.6, icon: 'river', itemId: `river:${r.id}` }));
  const heat = (Array.isArray(L.heat) ? L.heat : []).filter((h) => Number.isFinite(h.lat))
    .map((h) => ({ name: str(h.name, 60), sub: 'Heat station (forecast)', lat: h.lat, lng: h.lng, alt: 1.2, icon: 'heat', itemId: `heat:${h.id}` }));
  return [...districts, ...dams, ...rivers, ...heat];
}

const COORD_RE = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

function placeHits(term) {
  const out = [];
  const m = COORD_RE.exec(term);
  if (m) {
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) out.push({ place: { name: `${lat.toFixed(4)}, ${lng.toFixed(4)}`, sub: 'Coordinates', lat, lng, alt: 0.8 }, score: 5 });
  }
  for (const p of placeList()) {
    const texts = [p.name, ...(p.aliases || [])].map((t) => t.toLowerCase());
    const exact = texts.some((t) => t === term);
    const prefix = texts.some((t) => t.startsWith(term) || t.split(/[\s(]+/).some((w) => w.startsWith(term)));
    if (!exact && !prefix && !texts.some((t) => t.includes(term))) continue;
    out.push({ place: p, score: exact ? 3.5 : prefix ? 2.5 : 1.2 });
  }
  return out;
}

/* Worldwide place lookup on request only (OpenStreetMap Nominatim: one request per tap, attributed). */
let osmBusy = false;
async function searchOsm(q) {
  if (osmBusy) return;
  osmBusy = true;
  const box = $('searchResults');
  box.innerHTML = '<div class="none">Searching OpenStreetMap\u2026</div>';
  try {
    const params = new URLSearchParams({ q: q.slice(0, 120), format: 'jsonv2', limit: '6', 'accept-language': 'en' });
    const rows = await getJson(`https://nominatim.openstreetmap.org/search?${params}`);
    searchHits = (Array.isArray(rows) ? rows : []).map((r) => ({
      place: { name: str(r.name || (r.display_name || '').split(',')[0], 60), sub: str(r.display_name, 90), lat: Number(r.lat), lng: Number(r.lon), alt: r.type === 'country' ? 25 : r.type === 'state' ? 8 : 1.2 },
      score: 1
    })).filter((h) => Number.isFinite(h.place.lat) && Number.isFinite(h.place.lng));
    searchActive = 0;
    box.innerHTML = searchHits.length
      ? searchHits.map((h, n) => hitHtml(h, n)).join('') + '<div class="osm-credit">Search \u00a9 OpenStreetMap contributors</div>'
      : '<div class="none">No places found.</div>';
  } catch (err) {
    box.innerHTML = `<div class="none">Place search failed (${esc(err.message)}).</div>`;
  } finally {
    setTimeout(() => { osmBusy = false; }, 1100);
  }
}

function hitHtml(h, n) {
  if (h.place) {
    const icon = h.place.icon || 'dot';
    return `
        <button type="button" data-hit="${n}" class="${n === 0 ? 'active' : ''}">
          <span class="ic" style="--c:#64d2b4;--m:url(${ATLAS.urls[icon]})"></span>
          <span class="lbl">${esc(h.place.name)}<small>${esc(h.place.sub)}</small></span>
          <span class="kind">Place</span>
        </button>`;
  }
  if (h.osm) {
    return `<button type="button" data-osm="1" class="osm-row"><span class="lbl">Search places worldwide for \u201c${esc(h.q)}\u201d</span><span class="kind">OSM</span></button>`;
  }
  return `
        <button type="button" data-hit="${n}" class="${n === 0 ? 'active' : ''}">
          <span class="ic" style="--c:${LAYERS[h.key].color};--m:url(${ATLAS.urls[iconFor(h.key, h.it).icon]})"></span>
          <span class="lbl">${esc(tagText(h.key, h.it) || h.it.title || h.it.name || h.it.id)}</span>
          <span class="kind">${esc(CHIP_LABEL[h.key])}</span>
        </button>`;
}

function runSearch(q) {
  const term = q.trim().toLowerCase();
  if (term.length < 2) return [];
  const hits = placeHits(term);
  for (const key of Object.keys(LAYERS)) {
    const fields = SEARCH_FIELDS[key];
    for (const it of data[key]) {
      const texts = fields(it).filter(Boolean).map((t) => String(t).toLowerCase());
      const exact = texts.some((t) => t === term);
      const prefix = texts.some((t) => t.startsWith(term));
      const any = prefix || texts.some((t) => t.includes(term));
      if (!any) continue;
      hits.push({ key, it, score: exact ? 3 : prefix ? 2 : 1 });
      if (hits.length > 400) break;
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 8);
}


function renderSearch() {
  const box = $('searchResults');
  const q = $('search').value;
  if (q.trim().length < 2) {
    box.hidden = true;
    return;
  }
  searchHits = runSearch(q);
  searchActive = 0;
  const osmRow = q.trim().length >= 3 && !COORD_RE.test(q) ? hitHtml({ osm: true, q: q.trim() }) : '';
  box.innerHTML = (searchHits.length
    ? searchHits.map((h, n) => hitHtml(h, n)).join('')
    : '<div class="none">No matches on the map.</div>') + osmRow;
  box.hidden = false;
}

function chooseHit(n) {
  const h = searchHits[n];
  if (!h) return;
  if (h.place) {
    const p = h.place;
    flyTo(p.lat, p.lng, RADIUS + p.alt);
    /* An alerted point is replaced by its alert, whose id extends the point id (reservoir:vaigai:full:medium). */
    const it = p.itemId ? (data.alerts || []).find((x) => x.id === p.itemId || x.id.startsWith(`${p.itemId}:`)) : null;
    if (it) showItemDetail('alerts', it);
    else showPlaceAt({ lat: p.lat, lng: p.lng }, p.name);
    $('search').value = '';
    $('searchResults').hidden = true;
    $('search').blur();
    return;
  }
  if (!LAYERS[h.key].visible) {
    setLayerVisible(h.key, true);
    syncChips();
  }
  flyTo(h.it.lat, h.it.lng, 190);
  showItemDetail(h.key, h.it);
  $('search').value = '';
  $('searchResults').hidden = true;
  $('search').blur();
}

let searchTimer = null;

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  fetch('poller/data/districts.json').then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (d && Array.isArray(d.districts)) {
      districts = d.districts.filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng)).map((x) => ({
        name: str(x.name, 60), sub: `District, ${str(x.state, 40)}`, lat: x.lat, lng: x.lng, alt: 1.6,
        itemId: `rain:${String(x.name).toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}`,
        aliases: Array.isArray(x.aliases) ? x.aliases.map((a) => str(a, 60)) : []
      }));
    }
  }).catch(() => {});
  $('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderSearch, 120);
  });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('search').value = '';
      $('searchResults').hidden = true;
      $('search').blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      chooseHit(searchActive);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!searchHits.length) return;
      searchActive = (searchActive + (e.key === 'ArrowDown' ? 1 : -1) + searchHits.length) % searchHits.length;
      document.querySelectorAll('#searchResults button').forEach((b, n) => b.classList.toggle('active', n === searchActive));
    }
  });
  $('searchResults').addEventListener('click', (e) => {
    if (e.target.closest('[data-osm]')) {
      searchOsm($('search').value.trim());
      return;
    }
    const b = e.target.closest('[data-hit]');
    if (b) chooseHit(Number(b.dataset.hit));
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.search')) $('searchResults').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement === document.body) {
      e.preventDefault();
      $('search').focus();
    }
  });

  setInterval(() => {
    const now = new Date();
    $('clock').innerHTML = `${now.toLocaleTimeString([], { hour12: false })}<br>${now.toISOString().slice(11, 16)} UTC`;
    if (activeTab === 'sources') renderSources();
    updateStatus();
    syncChips();
  }, 1000);
}
