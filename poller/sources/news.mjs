/**
 * News events for the poller: one GDELT DOC request an hour, processed by the shared
 * lib/news-core.mjs. Dashboard, digest and weekly brief only; never an alert.
 * GitHub's shared runner addresses are often rate-limited by GDELT (HTTP 429), so the
 * dashboard also queries GDELT directly and this copy is best effort.
 */
import { readFileSync } from 'node:fs';
import { buildGazetteer, mergeNews, newsQueryUrl } from '../lib/news-core.mjs';

export { categorize, placeHeadline, normalizeArticles } from '../lib/news-core.mjs';

export const NEWS_MIN_INTERVAL_MS = 60 * 60 * 1000;
const RETRY_WAIT_MS = 10000;

export function loadNewsGazetteer() {
  const india = JSON.parse(readFileSync(new URL('../data/india-places.json', import.meta.url), 'utf8'));
  const districts = JSON.parse(readFileSync(new URL('../data/districts.json', import.meta.url), 'utf8'));
  return buildGazetteer(districts, india);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchNews({ http, previous = [], lastFetchedAt = 0, now = Date.now(), minIntervalMs = NEWS_MIN_INTERVAL_MS, retryWaitMs = RETRY_WAIT_MS, gazetteer = loadNewsGazetteer() }) {
  if (now - lastFetchedAt < minIntervalMs) return null;
  const errors = [];
  let articles = null;
  for (let attempt = 0; attempt < 3 && !articles; attempt++) {
    if (attempt) await sleep(retryWaitMs * attempt);
    try {
      const { text } = await http.getText(newsQueryUrl(12), { timeoutMs: 30000 });
      /* Query errors come back as plain text with HTTP 200. */
      let body;
      try { body = JSON.parse(text); } catch { throw new Error(text.slice(0, 120).trim() || 'not JSON'); }
      articles = Array.isArray(body.articles) ? body.articles : [];
    } catch (err) {
      errors.push(err.message);
      if (!/HTTP 429|HTTP 5\d\d|timeout|network/.test(err.message)) break;
    }
  }
  if (!articles) throw new Error(`GDELT: ${errors.join('; ')}`);
  return { items: mergeNews(articles, gazetteer, previous, now), fetched: articles.length, errors };
}
