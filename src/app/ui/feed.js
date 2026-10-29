/** Event feed and notifications toggle. */
import { appState } from '../app-state.js';
import { $, SEVERITY, SEV_COLOR, esc, fmtTime, store } from '../core.js';
import { toast } from '../rules.js';
import { updateAlertLayer } from '../icons.js';
import { closeDetail, selectedEventId, showEventDetail } from './detail.js';
import { updateRuleCounts } from './rules-panel.js';

const renderedFeedIds = new Set();
let lastUnread = 0;

export function renderFeed({ animate = true } = {}) {
  const minSev = SEVERITY[$('sevFilter').value] ?? 0;
  const hideBaseline = $('hideBaseline').checked;
  const list = appState.events.filter((e) => SEVERITY[e.severity] >= minSev && !(hideBaseline && e.baseline)).slice(0, 200);
  const firstRender = renderedFeedIds.size === 0;
  $('feed').innerHTML = list.length
    ? list.map((e) => {
      const isNew = animate && !firstRender && !renderedFeedIds.has(e.id);
      const cls = ['ev', e.baseline ? 'baseline' : '', isNew ? 'enter' : '', e.id === selectedEventId ? 'selected' : ''].filter(Boolean).join(' ');
      return `
        <div class="${cls}" data-ev="${esc(e.id)}">
          <span class="bar" style="background:${SEV_COLOR[e.severity]}"></span>
          <div class="body">
            <div class="title">${esc(e.title)}</div>
            <div class="meta">${fmtTime(e.ts)} &middot; ${esc(e.ruleName)}${e.zone ? `<span class="tag">${esc(e.zone)}</span>` : ''}${e.baseline ? '<span class="tag">baseline</span>' : ''}</div>
          </div>
        </div>`;
    }).join('')
    : '<div class="empty">No events yet. Rule matches appear here as sources poll.</div>';
  renderedFeedIds.clear();
  list.forEach((e) => renderedFeedIds.add(e.id));
  if (firstRender && !list.length) renderedFeedIds.add('__init__');

  const badge = $('unread');
  badge.textContent = appState.unread;
  badge.classList.toggle('zero', appState.unread === 0);
  if (appState.unread > lastUnread) {
    badge.classList.add('bump');
    setTimeout(() => badge.classList.remove('bump'), 220);
  }
  lastUnread = appState.unread;
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  $('feed').addEventListener('click', (e) => {
    const row = e.target.closest('[data-ev]');
    if (!row) return;
    const ev = appState.events.find((x) => x.id === row.dataset.ev);
    if (ev) showEventDetail(ev);
    if (appState.unread) {
      appState.unread = 0;
      renderFeed({ animate: false });
    }
  });
  $('feedTitle').addEventListener('click', () => { appState.unread = 0; renderFeed({ animate: false }); });
  $('sevFilter').addEventListener('change', () => renderFeed({ animate: false }));
  $('hideBaseline').addEventListener('change', () => renderFeed({ animate: false }));

  $('btnClear').addEventListener('click', () => {
    appState.events = [];
    appState.unread = 0;
    store.set('events', appState.events);
    closeDetail();
    renderFeed({ animate: false });
    updateAlertLayer();
    updateRuleCounts();
  });

  $('btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(appState.events, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `global-monitor-events-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('btnNotify').addEventListener('click', async () => {
    const btn = $('btnNotify');
    if (appState.notifyEnabled) {
      appState.notifyEnabled = false;
    } else if (!('Notification' in window)) {
      toast({ severity: 'medium', title: 'Browser notifications are not supported here.' });
      return;
    } else {
      try {
        const perm = await Notification.requestPermission();
        appState.notifyEnabled = perm === 'granted';
        if (!appState.notifyEnabled) toast({ severity: 'medium', title: 'Notification permission was not granted.' });
      } catch {
        toast({ severity: 'medium', title: 'Notifications are blocked in this context.' });
      }
    }
    btn.textContent = appState.notifyEnabled ? 'Notify on' : 'Notify off';
    btn.classList.toggle('on', appState.notifyEnabled);
  });
}
