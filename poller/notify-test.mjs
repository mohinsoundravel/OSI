#!/usr/bin/env node
/**
 * Sends one Telegram test message and reports the outcome in plain language.
 * Prints only HTTP status and Telegram's error description, never the token.
 * Exit code 0 = delivered, 1 = not delivered.
 */

const token = process.env.TELEGRAM_BOT_TOKEN || '';
const chatId = process.env.TELEGRAM_CHAT_ID || '';

const report = (ok, lines) => {
  console.log([`telegram test: ${ok ? 'DELIVERED' : 'FAILED'}`, ...lines].join('\n'));
  process.exitCode = ok ? 0 : 1;
};

const HINTS = {
  401: 'The bot token is invalid or was revoked. Update the TELEGRAM_BOT_TOKEN secret with the current token from @BotFather.',
  400: 'Telegram rejected the chat ID. Check TELEGRAM_CHAT_ID is your own numeric user ID (from @userinfobot), not the bot ID, and that you pressed Start in your bot.',
  403: 'The bot is not allowed to message you. Open your bot in Telegram and press Start (or unblock it), then run the test again.',
  404: 'The bot token format is wrong. Re-copy it from @BotFather.'
};

if (!token || !chatId) {
  report(false, [
    `TELEGRAM_BOT_TOKEN secret: ${token ? 'present' : 'MISSING'}`,
    `TELEGRAM_CHAT_ID secret: ${chatId ? 'present' : 'MISSING'}`,
    'Add the missing secret under Settings -> Secrets and variables -> Actions.'
  ]);
} else if (!/^-?\d{5,20}$/.test(chatId.trim())) {
  report(false, ['TELEGRAM_CHAT_ID is not a number. It should be digits only, e.g. 123456789.']);
} else if (chatId.trim() === token.split(':')[0]) {
  report(false, ['TELEGRAM_CHAT_ID is the bot\'s own ID. Use your personal ID from @userinfobot instead.']);
} else {
  const text = [
    'OSI monitor test message.',
    'Telegram alerts are working.',
    'You will hear from this bot only when a new or escalating alert affects your zones, or if a data source stops responding.'
  ].join('\n');
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId.trim(), text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000)
    });
    let description = '';
    try {
      description = String((await res.json()).description || '');
    } catch {
      /* non-JSON body */
    }
    if (res.ok) {
      report(true, ['Check Telegram: the test message should be there now.']);
    } else {
      report(false, [`Telegram answered HTTP ${res.status}${description ? `: ${description.slice(0, 200)}` : ''}`, HINTS[res.status] || 'Unexpected response from Telegram.']);
    }
  } catch (err) {
    /* Never print err.cause or the URL: they can contain the token. */
    report(false, [`Could not reach Telegram (${err.name}). Try again in a few minutes.`]);
  }
}
