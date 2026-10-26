/**
 * News events: Indian English-language headlines from the GDELT DOC 2.0 API, placed on
 * the map by the most specific Indian place named in the headline.
 *
 * GDELT is machine-collected and noisy, so this layer is strict: Indian sources only,
 * a fixed set of hazard, accident, unrest and security keywords, a headline must name a
 * known Indian place, near-duplicate headlines are merged, and nothing here triggers a
 * Telegram alert. Headlines are unverified and shown as such.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const NEWS_MIN_INTERVAL_MS = 60 * 60 * 1000;
const DOC_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
/* GDELT asks for at most one request every 5 seconds. */
const REQUEST_GAP_MS = 6000;
const KEEP_MS = 48 * 3600 * 1000;
const MAX_ITEMS = 300;

const QUERIES = [
  ['hazard', '(flood OR floods OR cyclone OR landslide OR "heavy rain" OR earthquake OR cloudburst OR "dam gates")'],
  ['accident', '(explosion OR "building collapse" OR derailment OR derailed OR stampede OR "gas leak" OR capsized OR "major fire" OR "fire breaks out")'],
  ['unrest', '(riot OR clashes OR curfew OR "internet shutdown" OR "prohibitory orders" OR encounter OR militants OR maoists OR "ied" OR terror OR "communal violence")']
];

/* Most specific category wins when a headline matches several. */
const CATEGORY_WORDS = [
  ['security', /\b(terror\w*|militants?|maoists?|naxal\w*|insurgents?|encounter|ied|grenade|gunfight|infiltrat\w*|ambush)\b/i],
  ['unrest', /\b(riots?|clash(?:es)?|curfew|protests?|mob|lathi|agitation|bandh|prohibitory|section 144|internet shutdown|communal|violence|arson)\b/i],
  ['accident', /\b(explosion|blast|collapse[sd]?|derail\w*|stampede|gas leak|capsiz\w*|fire|accident|crash(?:es|ed)?|tragedy)\b/i],
  ['hazard', /\b(floods?|flooding|cyclon\w*|landslides?|rain\w*|earthquake|tremors?|tsunami|cloudburst|storm|lightning|heat ?wave|drought|dam|inundat\w*|deluge)\b/i]
];

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Places: Tamil Nadu and neighbouring districts, Indian cities, then states (least specific). */
export function loadNewsGazetteer() {
  const india = JSON.parse(readFileSync(new URL('../data/india-places.json', import.meta.url), 'utf8'));
  const { districts } = JSON.parse(readFileSync(new URL('../data/districts.json', import.meta.url), 'utf8'));
  const ambiguous = new Set(india.ambiguous || []);
  const entry = (p, precision, state) => {
    const names = [p.name, ...(p.aliases || [])];
    /* Proper nouns: case-sensitive. Names that are also English words need a preposition. */
    const parts = names.map((n) => (ambiguous.has(n) ? `(?<=\\b(?:in|at|near|from|of)\\s)${escapeRegExp(n)}` : escapeRegExp(n)));
    return { name: p.name, state, lat: p.lat, lng: p.lng, precision, pattern: new RegExp(`(?<![\\w&])(?:${parts.join('|')})(?![\\w&])`) };
  };
  return [
    ...districts.map((d) => entry(d, 'district', d.state)),
    ...india.cities.map((c) => entry(c, 'city', c.state)),
    ...india.states.map((s) => entry(s, 'state', s.name))
  ];
}

export function placeHeadline(title, gazetteer) {
  for (const p of gazetteer) if (p.pattern.test(title)) return p;
  return null;
}

export function categorize(title) {
  for (const [cat, re] of CATEGORY_WORDS) if (re.test(title)) return cat;
  return null;
}

const normTitle = (t) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);

/** GDELT seendate "20261025T191500Z" to ISO. */
function seenIso(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(s || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

/** Turns DOC API articles into placed, categorised, de-duplicated items. */
export function normalizeArticles(articles, gazetteer, seed = []) {
  const urlKey = (href) => createHash('sha256').update(href).digest('hex').slice(0, 12);
  const byTitle = new Map(seed.map((i) => [normTitle(i.title), i]));
  /* Every URL already counted (including merged duplicates), so reruns do not inflate counts. */
  const byUrl = new Set(seed.flatMap((i) => [i.id, ...(i.seen || [])]));
  for (const a of articles) {
    const title = String(a.title || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    let url;
    try { url = new URL(String(a.url || '')); } catch { continue; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    const key0 = urlKey(url.href);
    if (!title || byUrl.has(key0)) continue;
    if (a.language && a.language !== 'English') continue;
    const at = seenIso(a.seendate);
    if (!at) continue;
    const category = categorize(title);
    const place = category && placeHeadline(title, gazetteer);
    if (!place) continue;
    const key = normTitle(title);
    const dup = byTitle.get(key);
    if (dup) {
      dup.sources = Math.min(99, (dup.sources || 1) + 1);
      dup.seen = [...(dup.seen || []), key0].slice(-20);
      byUrl.add(key0);
      continue;
    }
    const item = {
      id: key0,
      title, url: url.href, domain: String(a.domain || url.hostname).slice(0, 80), at, category,
      place: place.name, state: place.state, precision: place.precision, lat: place.lat, lng: place.lng, sources: 1
    };
    byTitle.set(key, item);
    byUrl.add(key0);
  }
  return [...byTitle.values()];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchNews({ http, previous = [], lastFetchedAt = 0, now = Date.now(), minIntervalMs = NEWS_MIN_INTERVAL_MS, gapMs = REQUEST_GAP_MS, gazetteer = loadNewsGazetteer() }) {
  if (now - lastFetchedAt < minIntervalMs) return null;
  const articles = [];
  const errors = [];
  for (let i = 0; i < QUERIES.length; i++) {
    if (i) await sleep(gapMs);
    const params = new URLSearchParams({
      query: `${QUERIES[i][1]} sourcecountry:IN sourcelang:english`,
      mode: 'artlist', format: 'json', maxrecords: '75', timespan: '12h', sort: 'datedesc'
    });
    try {
      const { text } = await http.getText(`${DOC_URL}?${params}`, { timeoutMs: 30000 });
      /* Rate-limit and query errors come back as plain text with HTTP 200. */
      let body;
      try { body = JSON.parse(text); } catch { throw new Error(text.slice(0, 120).trim() || 'not JSON'); }
      articles.push(...(Array.isArray(body.articles) ? body.articles : []));
    } catch (err) {
      errors.push(`${QUERIES[i][0]}: ${err.message}`);
    }
  }
  if (errors.length === QUERIES.length) throw new Error(`GDELT: ${errors.join('; ')}`);
  const kept = previous.filter((x) => now - Date.parse(x.at) < KEEP_MS);
  const items = normalizeArticles(articles, gazetteer, kept)
    .filter((x) => now - Date.parse(x.at) < KEEP_MS)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, MAX_ITEMS);
  return { items, fetched: articles.length, errors };
}
