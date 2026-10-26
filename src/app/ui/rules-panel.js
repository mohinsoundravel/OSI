/** Rules tab. */
import { appState } from '../app-state.js';
import { $, esc, store } from '../core.js';
import { LAYERS } from '../layers.js';
import { ruleInit, transitionState } from '../state.js';
import { RULE_DEFS, reevaluateAll, ruleCfg } from '../rules.js';

const ruleFireCount = (id) => appState.events.filter((e) => e.ruleId === id).length;

export function updateRuleCounts() {
  document.querySelectorAll('[data-count]').forEach((el) => {
    el.textContent = `${ruleFireCount(el.dataset.count)} fired`;
  });
}

export function renderRules() {
  const zoneOptions = (selected) => appState.zones.map((z) =>
    `<option value="${esc(z.id)}"${z.id === selected ? ' selected' : ''}>${esc(z.name)}</option>`).join('');

  const cards = RULE_DEFS.map((def) => {
    const c = ruleCfg[def.id];
    const params = def.params.map((p) => {
      const v = c.params[p.key];
      let input;
      if (p.type === 'select') {
        input = `<select data-param="${def.id}:${p.key}">${p.options.map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      } else if (p.type === 'zone') {
        input = `<select data-param="${def.id}:${p.key}">${zoneOptions(v)}</select>`;
      } else {
        input = `<input type="${p.type}"${p.step ? ` step="${p.step}"` : ''} value="${esc(v)}" data-param="${def.id}:${p.key}">`;
      }
      return `<div class="field"><span>${esc(p.label)}</span>${input}</div>`;
    }).join('');
    const scope = def.scopeLocked ? '' : `
        <div class="field"><span>Scope</span>
          <select data-scope="${def.id}">
            <option value="zones"${c.scope === 'zones' ? ' selected' : ''}>Watch zones</option>
            <option value="global"${c.scope === 'global' ? ' selected' : ''}>Global</option>
          </select>
        </div>`;
    return `
        <div class="rule${c.enabled ? '' : ' disabled'}">
          <label class="rule-head"><input type="checkbox" data-enable="${def.id}"${c.enabled ? ' checked' : ''}>${esc(def.name)}<span class="count" data-count="${def.id}">${ruleFireCount(def.id)} fired</span></label>
          <div class="rule-desc">${esc(def.description)} &middot; ${esc(LAYERS[def.layer].label)}</div>
          ${scope}${params}
        </div>`;
  }).join('');

  $('tab-rules').innerHTML =
    '<div class="note">Rules run on every poll. A new or edited rule first records existing matches as <b>baseline</b> (logged, no alert) so only genuinely new events notify you. Matches are de-duplicated for 3 days.</div>' + cards;
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  $('tab-rules').addEventListener('change', (e) => {
    const t = e.target;
    let id;
    if (t.dataset.enable) {
      id = t.dataset.enable;
      ruleCfg[id].enabled = t.checked;
    } else if (t.dataset.scope) {
      id = t.dataset.scope;
      ruleCfg[id].scope = t.value;
    } else if (t.dataset.param) {
      const [ruleId, key] = t.dataset.param.split(':');
      id = ruleId;
      const p = RULE_DEFS.find((d) => d.id === ruleId).params.find((x) => x.key === key);
      ruleCfg[ruleId].params[key] = p.type === 'number' ? Number(t.value) : t.value;
      if (key === 'observerZone') transitionState.delete(ruleId);
    } else {
      return;
    }
    ruleInit[id] = false;
    store.set('rules', ruleCfg);
    store.set('ruleInit', ruleInit);
    renderRules();
    reevaluateAll();
  });
}
