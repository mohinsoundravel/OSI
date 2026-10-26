import { createHash } from 'node:crypto';
import { SEVERITY_RANK } from './rules.mjs';

const TELEGRAM_LIMIT = 3900;
const MAX_MESSAGES_PER_RUN = 8;
const ICON = { critical: '[CRITICAL]', high: '[HIGH]', medium: '[MEDIUM]', low: '[LOW]' };

/**
 * Formats alerts as plain text. No parse_mode is used, so text from feeds can
 * never be interpreted as Telegram markup.
 */
export function formatAlert(a) {
  const lines = [
    `${ICON[a.severity]} ${a.title}`,
    `${a.origin === 'official' ? 'Official' : 'Derived (not an official warning)'} - ${a.source}`
  ];
  if (a.summary) lines.push(a.summary);
  if (a.instruction) lines.push(`Advice: ${a.instruction}`);
  if (a.zones?.length) lines.push(`Zones: ${a.zones.join(', ')}`);
  if (a.expires) lines.push(`Valid until: ${new Date(a.expires).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  if (a.sourceUrl) lines.push(a.sourceUrl);
  return lines.join('\n');
}

const truncate = (s) => (s.length > TELEGRAM_LIMIT ? `${s.slice(0, TELEGRAM_LIMIT - 20)}\n... (truncated)` : s);

/**
 * Critical and high alerts go out as individual messages; medium (and low, if
 * enabled) are grouped into a single digest. A hard per-run cap prevents a feed
 * glitch from flooding the chat. Each message carries the alerts it covers, so
 * feedback buttons can be attached.
 */
export function buildAlertMessages(alerts, { minSeverity = 'medium' } = {}) {
  const floor = SEVERITY_RANK[minSeverity] ?? 1;
  const eligible = alerts.filter((a) => SEVERITY_RANK[a.severity] >= floor)
    .sort((x, y) => SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity]);
  const urgent = eligible.filter((a) => SEVERITY_RANK[a.severity] >= SEVERITY_RANK.high);
  const rest = eligible.filter((a) => SEVERITY_RANK[a.severity] < SEVERITY_RANK.high);

  const messages = urgent.slice(0, MAX_MESSAGES_PER_RUN - 1).map((a) => ({ text: truncate(formatAlert(a)), alerts: [a] }));
  const overflow = urgent.slice(MAX_MESSAGES_PER_RUN - 1);
  const digestItems = [...overflow, ...rest];
  if (digestItems.length) {
    const body = digestItems.map((a) => `- ${ICON[a.severity]} ${a.title} (${a.origin})`).join('\n');
    messages.push({ text: truncate(`Monitor digest: ${digestItems.length} alert(s)\n${body}`), alerts: digestItems });
  }
  return messages;
}

export const buildMessages = (alerts, options) => buildAlertMessages(alerts, options).map((m) => m.text);

/** Short id for a message's feedback buttons (Telegram allows 64 bytes of callback data). */
export const feedbackId = (keys) => createHash('sha256').update(keys.join('|')).digest('hex').slice(0, 10);

/** "Useful" / "Noise" buttons under an alert message; taps are read by the next poll. */
export const feedbackKeyboard = (id) => ({
  inline_keyboard: [[{ text: 'Useful', callback_data: `fb:u:${id}` }, { text: 'Noise', callback_data: `fb:n:${id}` }]]
});

export function createNotifier({ token, chatId, dryRun = false, log = () => {} }) {
  const enabled = Boolean(token && chatId);
  async function send(text, { keyboard = null } = {}) {
    if (dryRun || !enabled) {
      log(`notify (${enabled ? 'dry-run' : 'disabled'}): ${text.split('\n')[0]}`);
      return true;
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true, ...(keyboard ? { reply_markup: keyboard } : {}) }),
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) {
        log(`notify: Telegram returned HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      /* Never log the request URL: it contains the bot token. */
      log(`notify: Telegram request failed (${err.name})`);
      return false;
    }
  }
  return { enabled, send };
}

/**
 * Dead-man's switch. Each run pings an external check (e.g. healthchecks.io);
 * if pings stop because the workflow was disabled, GitHub is down or the job
 * keeps crashing, that service alerts independently of this code.
 * Returns a status record (never the URL) so the outcome can be published.
 */
export async function heartbeat(url, { failed = false, body = '', log = () => {}, fetchImpl = globalThis.fetch } = {}) {
  const at = new Date().toISOString();
  if (!url) return { configured: false, ok: false, at, detail: 'HEALTHCHECK_URL secret not set' };
  let target;
  try {
    target = new URL(failed ? `${url.trim().replace(/\/+$/, '')}/fail` : url.trim());
  } catch {
    log('heartbeat: HEALTHCHECK_URL is not a valid URL');
    return { configured: true, ok: false, at, detail: 'HEALTHCHECK_URL is not a valid URL' };
  }
  if (target.protocol !== 'https:') {
    log('heartbeat: refusing non-https URL');
    return { configured: true, ok: false, at, detail: 'HEALTHCHECK_URL must start with https://' };
  }
  try {
    const res = await fetchImpl(target, { method: 'POST', body: body.slice(0, 10000), signal: AbortSignal.timeout(10000) });
    const ok = res.status >= 200 && res.status < 300;
    if (!ok) log(`heartbeat: HTTP ${res.status}`);
    return { configured: true, ok, at, status: res.status, signal: failed ? 'fail' : 'success', host: target.hostname };
  } catch (err) {
    log(`heartbeat: request failed (${err.name})`);
    return { configured: true, ok: false, at, detail: `request failed (${err.name})`, host: target.hostname };
  }
}
