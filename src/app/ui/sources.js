/** Sources tab: layer health, poller URL and API keys. */
import { $, esc, relTime, store } from '../core.js';
import { LAYERS, UNAVAILABLE_SOURCES, autoBackendUrl } from '../layers.js';
import { data, health } from '../state.js';
import { toast } from '../rules.js';
import { ATLAS, LAYER_ICON, setLayerVisible, updateLayer } from '../icons.js';
import { leaveView } from './views.js';
import { runSource } from '../scheduler.js';

let sourcesBuilt = false;

function buildSources() {
  const rows = Object.entries(LAYERS).map(([key, l]) => `
        <div class="src" data-src="${key}">
          <label class="src-head">
            <input type="checkbox" data-layer="${key}" ${l.visible ? 'checked' : ''}>
            <span class="sw-ic" style="--c:${l.color};--m:url(${ATLAS.urls[LAYER_ICON[key]]})"></span>
            <span class="src-name">${esc(l.label)}<span class="src-sub">${esc(l.source)}</span></span>
            <span class="pill" data-f="pill"></span>
            <span class="count" data-f="count">0</span>
          </label>
          <div class="src-meta" data-f="meta"></div>
          <div class="src-err" data-f="err" hidden></div>
        </div>`).join('');
  const na = UNAVAILABLE_SOURCES.map((u) => `
        <div class="src na">
          <div class="src-head"><input type="checkbox" disabled><span class="sw" style="background:#5b6372;color:transparent"></span><span class="src-name">${esc(u.label)}</span><span class="pill">n/a</span></div>
          <div class="src-meta">${esc(u.why)}</div>
        </div>`).join('');
  $('sourcesList').innerHTML = `
      <div class="section-label">Live layers</div><div class="group">${rows}</div>
      ${na ? `<div class="section-label">Not available client-side</div><div class="group">${na}</div>` : ''}
      <div class="note">Failed sources retry with exponential backoff (max 10 min). White satellites are above the observer's horizon right now.</div>`;
  sourcesBuilt = true;
}

export function renderSources() {
  if (!sourcesBuilt) buildSources();
  for (const key of Object.keys(LAYERS)) {
    const row = document.querySelector(`[data-src="${key}"]`);
    if (!row) continue;
    const h = health[key];
    const f = (name) => row.querySelector(`[data-f="${name}"]`);
    const pill = f('pill');
    const pillText = h.status === 'off' ? 'setup' : h.status;
    if (pill.textContent !== pillText) {
      pill.textContent = pillText;
      pill.className = `pill ${h.status}`;
    }
    const count = data[key].length.toLocaleString();
    if (f('count').textContent !== count) f('count').textContent = count;
    const nextIn = h.nextAt ? Math.max(0, Math.round((h.nextAt - Date.now()) / 1000)) : null;
    f('meta').textContent = `Updated ${relTime(h.lastOk)} \u00b7 ${h.latencyMs != null ? `${h.latencyMs} ms` : '-'} \u00b7 next ${nextIn != null ? `${nextIn}s` : '-'}${h.failures ? ` \u00b7 ${h.failures} failed` : ''}`;
    const err = f('err');
    err.hidden = !h.error;
    if (h.error && err.textContent !== h.error) err.textContent = h.error;
  }
}

export function renderKeyBox() {
  const hasKey = Boolean(store.get('windyKey', ''));
  const backendUrl = store.get('backendUrl', '');
  const auto = autoBackendUrl();
  $('keyBox').innerHTML = `
      <div class="keybox">
        <div class="src-name">Poller data URL</div>
        <div class="src-meta" style="margin-left:0">${auto
        ? 'Detected automatically from this GitHub Pages site. Override only if the data lives elsewhere.'
        : "Folder containing latest.json from the Monitor workflow's <b>data</b> branch. Must be https and publicly readable."}</div>
        <div class="field"><input type="url" id="backendUrlInput" placeholder="${esc(auto || 'https://...')}" value="${esc(backendUrl)}" autocomplete="off" spellcheck="false">
          <button class="btn" id="backendUrlSave">Save</button></div>
      </div>`;
  $('keyBox').insertAdjacentHTML('beforeend', `
      <div class="keybox">
        <div class="src-name">Windy Webcams API key</div>
        <div class="src-meta" style="margin-left:0">Free key from api.windy.com/keys. Stored only in this browser. Visible to anyone with access to this browser profile.</div>
        <div class="field"><input type="password" id="windyKeyInput" placeholder="${hasKey ? 'key saved' : 'paste key'}" autocomplete="off">
          <button class="btn" id="windyKeySave">Save</button>${hasKey ? '<button class="btn" id="windyKeyClear">Clear</button>' : ''}</div>
      </div>`);
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  $('keyBox').addEventListener('click', (e) => {
    if (e.target.id === 'backendUrlSave') {
      const value = $('backendUrlInput').value.trim();
      if (value) {
        let ok = false;
        try {
          const u = new URL(value);
          ok = u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1';
        } catch { /* invalid URL */ }
        if (!ok) {
          toast({ severity: 'medium', title: 'Poller data URL must be a valid https URL.' });
          return;
        }
      }
      store.set('backendUrl', value);
      renderKeyBox();
      runSource('alerts');
      return;
    }
    if (e.target.id === 'windyKeySave') {
      const value = $('windyKeyInput').value.trim();
      if (!value) return;
      store.set('windyKey', value);
      renderKeyBox();
      runSource('webcams');
    } else if (e.target.id === 'windyKeyClear') {
      store.set('windyKey', '');
      data.webcams = [];
      updateLayer('webcams');
      renderKeyBox();
    }
  });

  $('tab-sources').addEventListener('change', (e) => {
    const key = e.target.dataset.layer;
    if (!key) return;
    setLayerVisible(key, e.target.checked);
    leaveView();
  });
}
