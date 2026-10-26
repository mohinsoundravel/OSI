/** Detail panel rendering. */
import { appState } from '../app-state.js';
import { $, SEV_COLOR, esc, fmtTime } from '../core.js';
import { EMBED_SRC_RE, LAYERS } from '../layers.js';
import { addSpot, hideSelector, placeSelector } from '../spots.js';
import { flyTo } from '../camera.js';
import { updatePath } from '../tags.js';
import { attachChart } from './charts.js';
import { openPanel } from './panels.js';

const isHttps = (u) => typeof u === 'string' && /^https:\/\//.test(u);

export function renderDetail({ kind, title, fields, url, linkLabel = 'Source report', severity, meta = [], image = null, imageLink = null, embed = null, chartSlot = false }) {
  const el = $('detail');
  const rows = meta.concat(fields).map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
  const link = isHttps(url)
    ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(linkLabel)}</a>` : '<span></span>';
  const media = isHttps(image) ? `
      <figure class="cam">
        <a href="${esc(isHttps(imageLink) ? imageLink : image)}" target="_blank" rel="noopener noreferrer">
          <img src="${esc(image)}" alt="${esc(title)}" loading="lazy" referrerpolicy="no-referrer">
        </a>
        <figcaption>Webcams provided by <a href="https://www.windy.com/" target="_blank" rel="noopener noreferrer">windy.com</a></figcaption>
      </figure>` : '';
  el.innerHTML = `
      <div class="kind"${severity ? ` style="color:${SEV_COLOR[severity]}"` : ''}>${esc(kind)}${severity ? ` &middot; ${esc(severity)}` : ''}</div>
      <h2>${esc(title)}</h2>${playerHtml(embed)}${media}${chartSlot ? '<div class="chart-slot"></div>' : ''}${rows}
      <div class="detail-actions">${link}<button class="btn" data-action="close-detail">Close</button></div>`;
  const img = el.querySelector('.cam img');
  if (img) {
    img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
    img.addEventListener('error', () => {
      img.closest('a').outerHTML = '<div class="cam-err">Image expired or unavailable. It refreshes on the next webcam poll.</div>';
    }, { once: true });
  }
  el.scrollTop = 0;
  $('detailWrap').classList.add('open');
  $('right').classList.add('detail-open');
  openPanel('right');
}

/** A tap-to-play placeholder; the iframe is created only on tap, from a re-validated URL. */
function playerHtml(embed) {
  if (!embed || !EMBED_SRC_RE.test(embed.src)) return '';
  return `
      <div class="player" data-embed="${esc(embed.src)}">
        <button class="play-btn" type="button" data-play><span class="tri" aria-hidden="true"></span>${esc(embed.label)}</button>
        <div class="player-meta">${esc(embed.note)}${isHttps(embed.open) ? ` <a href="${esc(embed.open)}" target="_blank" rel="noopener noreferrer">Open</a>` : ''}</div>
      </div>`;
}

export function closeDetail() {
  appState.selectedRef = null;
  appState.tagsDirty = true;
  updatePath(true);
  $('detailWrap').classList.remove('open'); $('right').classList.remove('detail-open');
  selectedEventId = null;
  document.querySelectorAll('.ev.selected').forEach((n) => n.classList.remove('selected'));
  hideSelector();
}

export function showItemDetail(key, it) {
  appState.selectedRef = { key, id: it.id };
  appState.tagsDirty = true;
  updatePath(true);
  selectedEventId = null;
  document.querySelectorAll('.ev.selected').forEach((n) => n.classList.remove('selected'));
  const d = LAYERS[key].describe(it);
  renderDetail({ kind: LAYERS[key].label, title: d.title, fields: d.fields, url: d.url, linkLabel: d.linkLabel, image: d.image, imageLink: d.imageLink, embed: d.embed, chartSlot: key === 'alerts' });
  attachChart(key, it);
  placeSelector(it.lat, it.lng, it.altKm);
}

export let selectedEventId = null;

export function showEventDetail(ev) {
  appState.selectedRef = null;
  appState.tagsDirty = true;
  updatePath(true);
  selectedEventId = ev.id;
  document.querySelectorAll('.ev').forEach((n) => n.classList.toggle('selected', n.dataset.ev === ev.id));
  renderDetail({
    kind: ev.ruleName, title: ev.title, fields: ev.fields, url: ev.url, severity: ev.severity,
    meta: [['Detected', fmtTime(ev.ts)], ...(ev.zone ? [['Zone', ev.zone]] : []), ['Baseline', ev.baseline ? 'yes' : 'no']]
  });
  placeSelector(ev.lat, ev.lng, ev.altKm);
  flyTo(ev.lat, ev.lng);
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  $('detail').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-play]');
    if (!btn) return;
    const box = btn.closest('.player');
    const src = box && box.dataset.embed;
    if (!src || !EMBED_SRC_RE.test(src)) return;
    const frame = document.createElement('iframe');
    frame.src = src;
    frame.title = 'Live player';
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-presentation');
    box.classList.add('playing');
    btn.replaceWith(frame);
  });

  $('detail').addEventListener('click', (e) => {
    if (e.target.dataset.action === 'close-detail') closeDetail();
    if (e.target.dataset.action === 'add-spot') {
      const lat = Number(e.target.dataset.lat);
      const lng = Number(e.target.dataset.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        addSpot(e.target.dataset.name || 'Spot', lat, lng);
        e.target.disabled = true;
        e.target.textContent = 'Added';
      }
    }
  });
}
