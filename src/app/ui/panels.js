/** Tabs, side panels and bottom sheets, clock, layer chips. */
import { appState } from '../app-state.js';
import { $, esc } from '../core.js';
import { LAYERS } from '../layers.js';
import { data } from '../state.js';
import { renderLegend } from '../map-controls.js';
import { ATLAS, LAYER_ICON, setLayerVisible } from '../icons.js';
import { renderSources } from './sources.js';
import { VIEWS, applyView, leaveView } from './views.js';

const TAB_ORDER = ['sources', 'rules', 'zones'];
export let activeTab = 'sources';

export const isCompact = () => window.matchMedia('(max-width: 900px)').matches;

function syncSheetState() {
  document.body.classList.toggle('sheet-open', $('left').classList.contains('open') || $('right').classList.contains('open'));
}
export function openPanel(side, full = false) {
  if (!isCompact()) return;
  $(side === 'left' ? 'right' : 'left').classList.remove('open', 'full');
  $(side).classList.add('open');
  $(side).classList.toggle('full', full);
  syncSheetState();
  appState.tagsDirty = true;
}
export function closePanels() {
  for (const id of ['left', 'right']) $(id).classList.remove('open', 'full');
  syncSheetState();
  appState.tagsDirty = true;
}

/* ----- Layer chips ----- */
export const CHIP_LABEL = { flights: 'Flights', quakes: 'Quakes', gdacs: 'GDACS', eonet: 'Events', satellites: 'Satellites', webcams: 'Cams', live: 'Live', ships: 'Ships', alerts: 'India' };

export function buildChips() {
  $('chips').innerHTML = Object.entries(VIEWS).map(([k, v]) => `
      <button class="chip view" type="button" data-view="${k}" aria-pressed="false">${esc(v.label)}</button>`).join('')
    + '<span class="chip-sep" aria-hidden="true"></span>'
    + Object.keys(LAYERS).map((key) => `
      <button class="chip${LAYERS[key].visible ? '' : ' off'}" type="button" data-chip="${key}" aria-pressed="${LAYERS[key].visible}">
        <span class="ic" style="--c:${LAYERS[key].color};--m:url(${ATLAS.urls[LAYER_ICON[key]]})"></span>${CHIP_LABEL[key]}<span class="n" data-n="${key}"></span>
      </button>`).join('');
}
export function syncChips() {
  if ($('legend') && !$('legend').hidden) renderLegend();
  for (const key of Object.keys(LAYERS)) {
    const chip = document.querySelector(`[data-chip="${key}"]`);
    if (!chip) continue;
    chip.classList.toggle('off', !LAYERS[key].visible);
    chip.setAttribute('aria-pressed', String(LAYERS[key].visible));
    const n = data[key].length;
    const label = n ? (n > 999 ? `${(n / 1000).toFixed(1)}k` : String(n)) : '';
    const el = chip.querySelector('[data-n]');
    if (el.textContent !== label) el.textContent = label;
  }
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  $('tabs').addEventListener('click', (e) => {
    const tab = e.target.dataset.tab;
    if (!tab || tab === activeTab) return;
    const forward = TAB_ORDER.indexOf(tab) > TAB_ORDER.indexOf(activeTab);
    const prev = $(`tab-${activeTab}`);
    prev.classList.toggle('leaving-left', forward);
    prev.classList.remove('active');
    const next = $(`tab-${tab}`);
    next.style.transition = 'none';
    next.classList.toggle('leaving-left', !forward);
    void next.offsetWidth;
    next.style.transition = '';
    next.classList.remove('leaving-left');
    next.classList.add('active');
    activeTab = tab;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('tabIndicator').style.transform = `translateX(${TAB_ORDER.indexOf(tab) * 100}%)`;
    if (tab === 'sources') renderSources();
  });
  $('toggleLeft').addEventListener('click', () => openPanel('left'));
  $('toggleRight').addEventListener('click', () => openPanel('right'));

  /* Bottom sheets on phones: drag the grabber or header to snap between half, full and closed. */
  for (const id of ['left', 'right']) {
    const sheet = $(id);
    let drag = null;
    let suppressClick = false;
    const start = (e) => {
      if (!isCompact() || !sheet.classList.contains('open')) return;
      if (e.target.closest('button:not(.grabber), input, select, a, label')) return;
      const vh = window.innerHeight;
      const base = sheet.classList.contains('full') ? 0 : 0.36 * vh;
      drag = { y0: e.clientY, base, t0: performance.now(), lastY: e.clientY, lastT: performance.now(), moved: false };
      sheet.classList.add('dragging');
      e.currentTarget.setPointerCapture(e.pointerId);
    };
    const move = (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y0;
      if (Math.abs(dy) > 4) drag.moved = true;
      drag.vy = (e.clientY - drag.lastY) / Math.max(1, performance.now() - drag.lastT);
      drag.lastY = e.clientY;
      drag.lastT = performance.now();
      sheet.style.transform = `translateY(${Math.max(0, drag.base + dy)}px)`;
    };
    const end = (e) => {
      if (!drag) return;
      const vh = window.innerHeight;
      const y = Math.max(0, drag.base + (e.clientY - drag.y0));
      const projected = y + (drag.vy || 0) * 180;
      sheet.classList.remove('dragging');
      sheet.style.transform = '';
      if (drag.moved) {
        suppressClick = true;
        if (projected > 0.66 * vh) closePanels();
        else if (projected < 0.18 * vh) openPanel(id, true);
        else openPanel(id, false);
      }
      drag = null;
    };
    for (const handle of sheet.querySelectorAll('.grabber, .panel-head')) {
      handle.addEventListener('pointerdown', start);
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    }
    sheet.querySelector('.grabber').addEventListener('click', () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (sheet.classList.contains('full')) openPanel(id, false);
      else closePanels();
    });
  }
  $('chips').addEventListener('click', (e) => {
    const view = e.target.closest('[data-view]');
    if (view) {
      applyView(view.dataset.view);
      return;
    }
    const chip = e.target.closest('[data-chip]');
    if (!chip) return;
    leaveView();
    const key = chip.dataset.chip;
    setLayerVisible(key, !LAYERS[key].visible);
    const box = document.querySelector(`[data-layer="${key}"]`);
    if (box) box.checked = LAYERS[key].visible;
    appState.tagsDirty = true;
    syncChips();
  });
}
