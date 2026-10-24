/**
 * Telegram commands, answered from the poll that follows them (so replies can take up
 * to about 15 minutes; there is no always-on server).
 *
 * Security: only messages from the configured chat are answered; everything else is
 * ignored without a reply, so a stranger who finds the bot learns nothing. Message
 * text is never echoed or logged, replies are plain text (no parse_mode), and at most
 * a few replies are sent per run.
 */

const MAX_REPLIES_PER_RUN = 5;
const HELP = [
  'OSI monitor commands (answered within about 15 minutes):',
  '/status - data age, sources, alert count',
  '/alerts - active alerts in your zones',
  '/dams - reservoir levels, inflow and outflow',
  '/rain - wettest districts in the 3-day forecast',
  '/help - this list'
].join('\n');

const fmtInt = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-IN') : '?');
const istTime = (iso) => {
  const d = new Date(Date.parse(iso) + 5.5 * 3600 * 1000);
  return Number.isFinite(d.getTime()) ? `${d.toISOString().slice(11, 16)} IST ${d.toISOString().slice(0, 10)}` : 'unknown';
};

/** Builds the reply for one command from the run's published outputs. */
export function answerCommand(command, latest) {
  const cmd = String(command).trim().split(/[\s@]/)[0].toLowerCase();
  const active = Array.isArray(latest.active) ? latest.active : [];
  const rank = { critical: 3, high: 2, medium: 1, low: 0 };
  switch (cmd) {
    case '/start':
    case '/help':
      return HELP;
    case '/status': {
      const health = Object.entries(latest.health || {});
      const failing = health.filter(([, h]) => !h.ok).map(([k]) => k);
      const bySev = ['critical', 'high', 'medium', 'low'].map((s) => [s, active.filter((a) => a.severity === s).length]).filter(([, n]) => n);
      return [
        `OSI monitor, updated ${istTime(latest.generatedAt)}`,
        `Sources ok ${health.length - failing.length}/${health.length}${failing.length ? ` (failing: ${failing.join(', ')})` : ''}`,
        `Active alerts: ${active.length}${bySev.length ? ` (${bySev.map(([s, n]) => `${n} ${s}`).join(', ')})` : ''}`,
        `Heartbeat: ${latest.heartbeat?.ok ? 'ok' : latest.heartbeat?.configured ? 'failing' : 'not configured'}`
      ].join('\n');
    }
    case '/alerts': {
      if (!active.length) return 'No active alerts in your zones.';
      const top = [...active].sort((a, b) => rank[b.severity] - rank[a.severity]).slice(0, 12);
      return [`Active alerts (${active.length}):`, ...top.map((a) => `- [${a.severity}] ${a.title} (${a.origin})`)].join('\n');
    }
    case '/dams': {
      const r = latest.layers?.reservoirs;
      const items = Array.isArray(r?.items) ? r.items : [];
      if (!items.length) return 'No reservoir data yet.';
      const rows = [...items].sort((a, b) => (b.pctDepth ?? 0) - (a.pctDepth ?? 0)).map((d) => {
        const change = Number.isFinite(d.levelChangeFt) && d.levelChangeFt !== 0 ? ` (${d.levelChangeFt > 0 ? '+' : ''}${d.levelChangeFt} ft)` : '';
        return `- ${d.name}: ${d.levelFt ?? '?'}/${d.fullFt} ft${change}, in ${fmtInt(d.inflow)}, out ${fmtInt(d.outflow)}`;
      });
      return [`Reservoirs as on ${r.date} (level/full; cusecs):`, ...rows].join('\n');
    }
    case '/rain': {
      const rain = Array.isArray(latest.layers?.rain) ? latest.layers.rain : [];
      if (!rain.length) return 'No rain forecast data yet.';
      const top = rain.filter((x) => x.state === 'Tamil Nadu' || x.state === 'Puducherry')
        .sort((a, b) => (b.next72 || 0) - (a.next72 || 0)).slice(0, 10);
      return ['Wettest districts, next 3 days (model; IMD heavy is 64.5 mm/day):',
        ...top.map((x) => `- ${x.name}: ${x.next72} mm total, ${x.peakMm} mm on ${x.peakDate}`)].join('\n');
    }
    default:
      return `Unknown command. ${HELP}`;
  }
}

/**
 * Reads pending updates once, answers commands from the owner's chat, and returns the
 * next offset. Errors (including a webhook conflict, HTTP 409) leave the offset as is.
 */
export async function handleCommands({ token, chatId, offset = 0, latest, send, fetchImpl = globalThis.fetch, log = () => {} }) {
  if (!token || !chatId) return { offset, handled: 0 };
  let updates;
  try {
    const params = new URLSearchParams({ offset: String(offset), timeout: '0', allowed_updates: JSON.stringify(['message']) });
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates?${params}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      log(`commands: Telegram getUpdates returned HTTP ${res.status}`);
      return { offset, handled: 0 };
    }
    const body = await res.json();
    updates = Array.isArray(body.result) ? body.result : [];
  } catch (err) {
    log(`commands: getUpdates failed (${err.name})`);
    return { offset, handled: 0 };
  }
  let next = offset;
  let handled = 0;
  for (const u of updates) {
    if (Number.isInteger(u.update_id)) next = Math.max(next, u.update_id + 1);
    const m = u.message;
    if (!m || typeof m.text !== 'string' || !m.text.startsWith('/')) continue;
    if (String(m.chat?.id) !== String(chatId)) continue;
    if (handled >= MAX_REPLIES_PER_RUN) continue;
    await send(answerCommand(m.text, latest).slice(0, 3900));
    handled++;
  }
  return { offset: next, handled };
}

/** Registers the command menu once (Telegram shows it when "/" is typed). Returns true on success. */
export async function registerCommands({ token, fetchImpl = globalThis.fetch }) {
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [
        { command: 'status', description: 'Data age, sources, alert count' },
        { command: 'alerts', description: 'Active alerts in your zones' },
        { command: 'dams', description: 'Reservoir levels, inflow, outflow' },
        { command: 'rain', description: 'Wettest districts, next 3 days' },
        { command: 'help', description: 'List commands' }
      ] }),
      signal: AbortSignal.timeout(15000)
    });
    return res.ok;
  } catch {
    return false;
  }
}
