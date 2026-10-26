/**
 * Alert feedback and tuning.
 *
 * - Alert messages carry "Useful" / "Noise" buttons; the next poll records taps.
 * - /mute <group> [days] silences a rule group's notifications for a while (alerts are
 *   still recorded and shown on the dashboard); /unmute lifts it.
 * - A weekly review counts what fired per rule, how it was rated, and suggests the
 *   config change (or /mute) for rules the owner keeps marking as noise.
 */

const DAY_MS = 24 * 3600 * 1000;
const KEEP_MS = 21 * DAY_MS;
export const MAX_MUTE_DAYS = 30;

/** Short names used in Telegram commands, mapped to the rule ids in rules.mjs. */
export const RULE_GROUPS = {
  sachet: { rules: ['sachet_official'], label: 'Official SACHET alerts', tune: 'setting ruleOverrides.sachet_official.minSeverity to "high"' },
  river: { rules: ['river_discharge'], label: 'River-rise forecasts', tune: 'raising flood.ratioMedium and flood.ratioHigh, or minDischarge on the noisiest point' },
  rain: { rules: ['rain_imd_category'], label: 'District rain forecasts', tune: 'setting ruleOverrides.rain_imd_category.minSeverity to "high" (extremely heavy only)' },
  heat: { rules: ['heat_imd_criteria'], label: 'Heat-wave forecasts', tune: 'setting ruleOverrides.heat_imd_criteria.minSeverity to "high" (severe only)' },
  dam: { rules: ['reservoir_release', 'reservoir_full'], label: 'Dam releases and near-full reservoirs', tune: 'setting ruleOverrides.reservoir_full.enabled to false (keeps releases)' },
  gdacs: { rules: ['gdacs_level'], label: 'GDACS alerts', tune: 'setting gdacs.minLevel to "Red"' },
  quake: { rules: ['usgs_quake'], label: 'Earthquakes', tune: 'raising usgs.minMagnitude by 0.5' },
  squawk: { rules: ['flight_squawk'], label: 'Aircraft emergency squawks', tune: 'setting ruleOverrides.flight_squawk.minSeverity to "high" (drops radio failures)' },
  cyclone: { rules: ['cyclone_track'], label: 'Cyclone tracks', tune: 'lowering cyclones.withinKm' },
  sea: { rules: ['sea_state'], label: 'Rough-sea forecasts', tune: 'raising sea.roughM and sea.veryRoughM' },
  fire: { rules: ['forest_fire'], label: 'Forest fires', tune: 'raising fires.minDetections' }
};
const RULE_TO_GROUP = Object.fromEntries(Object.entries(RULE_GROUPS).flatMap(([g, v]) => v.rules.map((r) => [r, g])));
export const groupOfRule = (rule) => RULE_TO_GROUP[rule] || null;

const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Splits fresh alerts into those to notify and those held back by config overrides or an
 * active mute. Held-back alerts are still recorded as events.
 */
export function filterForNotify(alerts, { overrides = {}, mutes = {}, now }) {
  const notify = [];
  const held = [];
  for (const a of alerts) {
    const o = overrides[a.rule] || {};
    const group = groupOfRule(a.rule);
    const mutedUntil = group ? Date.parse(mutes[group] || '') : NaN;
    if (o.enabled === false) held.push({ ...a, heldBy: 'disabled in config' });
    else if (o.minSeverity && SEVERITY_RANK[a.severity] < (SEVERITY_RANK[o.minSeverity] ?? 0)) held.push({ ...a, heldBy: `below ${o.minSeverity}` });
    else if (Number.isFinite(mutedUntil) && mutedUntil > now) held.push({ ...a, heldBy: `muted until ${new Date(mutedUntil).toISOString().slice(0, 10)}` });
    else notify.push(a);
  }
  return { notify, held };
}

/** Remembers which alerts a message with buttons covered. */
export function rememberRefs(state, id, alerts, now) {
  state.feedbackRefs ||= {};
  state.feedbackRefs[id] = {
    at: new Date(now).toISOString(),
    items: alerts.slice(0, 20).map((a) => ({ key: String(a.key || a.id || '').slice(0, 200), rule: a.rule, title: String(a.title || '').slice(0, 120) }))
  };
}

/** Stores button taps ({ id, verdict }) against the alerts they refer to. */
export function recordFeedback(state, taps, now) {
  state.feedback ||= {};
  let recorded = 0;
  for (const t of taps) {
    if (!state.feedbackRefs?.[t.id]) continue;
    state.feedback[t.id] = { verdict: t.verdict === 'n' ? 'noise' : 'useful', at: new Date(now).toISOString() };
    recorded++;
  }
  return recorded;
}

export function pruneFeedback(state, now) {
  for (const bag of [state.feedbackRefs, state.feedback]) {
    if (!bag) continue;
    for (const [k, v] of Object.entries(bag)) if (!(now - Date.parse(v.at) < KEEP_MS)) delete bag[k];
  }
  for (const [g, until] of Object.entries(state.mutes || {})) if (!(Date.parse(until) > now)) delete state.mutes[g];
}

/** /mute, /unmute and /muted. Returns the reply text and mutates state.mutes. */
export function muteCommand(state, text, now) {
  const [cmd, rawGroup, rawDays] = String(text).trim().split(/\s+/);
  const command = cmd.split('@')[0].toLowerCase();
  state.mutes ||= {};
  const groupList = Object.keys(RULE_GROUPS).join(', ');
  if (command === '/muted') {
    const active = Object.entries(state.mutes).filter(([, u]) => Date.parse(u) > now);
    return active.length
      ? ['Muted (alerts still recorded on the dashboard):', ...active.map(([g, u]) => `- ${g} until ${u.slice(0, 16).replace('T', ' ')} UTC`)].join('\n')
      : 'Nothing is muted.';
  }
  const group = String(rawGroup || '').toLowerCase();
  if (!RULE_GROUPS[group]) return `Usage: ${command} <group>${command === '/mute' ? ' [days, default 7]' : ''}\nGroups: ${groupList}`;
  if (command === '/unmute') {
    const had = Boolean(state.mutes[group]);
    delete state.mutes[group];
    return had ? `Unmuted: ${RULE_GROUPS[group].label}.` : `${RULE_GROUPS[group].label} was not muted.`;
  }
  const days = Math.min(MAX_MUTE_DAYS, Math.max(1, Math.round(Number(rawDays) || 7)));
  state.mutes[group] = new Date(now + days * DAY_MS).toISOString();
  return `Muted for ${days} day(s): ${RULE_GROUPS[group].label}. Alerts are still recorded and shown on the dashboard. /unmute ${group} to undo.`;
}

/**
 * Weekly review: per rule group, alerts fired in the last 7 days (excluding the start-up
 * baseline), how they were rated, and a suggestion where the ratings support one.
 */
export function buildWeeklyReview({ events = [], state = {}, now }) {
  const since = now - 7 * DAY_MS;
  const fired = events.filter((e) => !e.baseline && Date.parse(e.detectedAt) >= since);
  const groups = new Map();
  const bump = (g, field, n = 1) => {
    if (!groups.has(g)) groups.set(g, { fired: 0, noise: 0, useful: 0, keys: new Map() });
    groups.get(g)[field] += n;
  };
  for (const e of fired) {
    const g = groupOfRule(e.rule) || 'other';
    bump(g, 'fired');
    const id = String(e.id || '').split(':').slice(0, 2).join(':');
    const entry = groups.get(g).keys;
    entry.set(id, (entry.get(id) || 0) + 1);
  }
  for (const [id, fb] of Object.entries(state.feedback || {})) {
    if (!(Date.parse(fb.at) >= since)) continue;
    const ref = state.feedbackRefs?.[id];
    if (!ref) continue;
    for (const g of new Set(ref.items.map((i) => groupOfRule(i.rule) || 'other'))) bump(g, fb.verdict === 'noise' ? 'noise' : 'useful');
  }
  const lines = ['OSI weekly alert review (last 7 days)'];
  if (!groups.size) {
    lines.push('No new alerts fired this week.');
  } else {
    lines.push('Group: fired / rated useful / rated noise');
    const sorted = [...groups.entries()].sort((a, b) => b[1].fired - a[1].fired);
    for (const [g, v] of sorted) lines.push(`- ${RULE_GROUPS[g]?.label || g}: ${v.fired} / ${v.useful} / ${v.noise}`);
    const suggestions = [];
    for (const [g, v] of sorted) {
      const rated = v.noise + v.useful;
      const info = RULE_GROUPS[g];
      if (!info) continue;
      if (rated >= 3 && v.noise / rated >= 0.5) {
        const top = [...v.keys.entries()].sort((a, b) => b[1] - a[1])[0];
        suggestions.push(`- ${info.label}: ${v.noise} of ${rated} rated noise. Consider ${info.tune}${top ? ` (most frequent: ${top[0]}, ${top[1]}x)` : ''}, or /mute ${g} 7.`);
      } else if (v.fired >= 15 && rated === 0) {
        suggestions.push(`- ${info.label}: ${v.fired} alerts and none rated. Tap Useful or Noise on a few so next week's review can tune it.`);
      }
    }
    lines.push('', suggestions.length ? 'Suggestions:' : 'No threshold changes suggested.', ...suggestions);
  }
  const muted = Object.entries(state.mutes || {}).filter(([, u]) => Date.parse(u) > now);
  if (muted.length) lines.push('', `Muted now: ${muted.map(([g, u]) => `${g} (until ${u.slice(0, 10)})`).join(', ')}`);
  lines.push('', 'Commands: /mute <group> [days], /unmute <group>, /muted');
  return lines.join('\n');
}
