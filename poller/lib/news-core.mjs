/**
 * Headline processing shared by the poller and the dashboard (no Node or browser APIs):
 * the GDELT query, categories, placement by the most specific Indian place named, and
 * de-duplication. GDELT is machine-collected and noisy, so it is strict: Indian English
 * sources, fixed keywords, a known place in the headline, near-duplicates merged.
 */

export const GDELT_DOC_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
export const NEWS_KEEP_MS = 48 * 3600 * 1000;
export const NEWS_MAX_ITEMS = 300;

/**
 * Query URLs for the last `hours` of Indian English headlines. GDELT rejects long queries
 * ("too short or too long"), so the keywords are split into three; callers space the
 * requests at least 5 seconds apart, as GDELT asks.
 */
export function newsQueryUrls(hours = 12) {
  return NEWS_QUERIES.map((terms) => {
    const params = new URLSearchParams({
      query: `(${terms.join(' OR ')}) sourcecountry:IN sourcelang:english`,
      mode: 'artlist', format: 'json', maxrecords: '100', timespan: `${hours}h`, sort: 'datedesc'
    });
    return `${GDELT_DOC_URL}?${params}`;
  });
}
export const NEWS_REQUEST_GAP_MS = 6000;

/** 48-bit FNV-1a style hash as 12 hex characters: a stable id for a URL. */
export function urlKey(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12);
}

/* Terms must be at least four characters or quoted phrases; categories are assigned locally. */
export const NEWS_QUERIES = [
  ['flood', 'floods', 'cyclone', 'landslide', '"heavy rain"', 'earthquake', 'cloudburst', '"dam gates"'],
  ['explosion', '"building collapse"', 'derailment', 'derailed', 'stampede', '"gas leak"', 'capsized', '"major fire"'],
  ['riot', 'clashes', 'curfew', '"internet shutdown"', '"prohibitory orders"', 'encounter', 'militants', 'maoists', '"ied blast"', '"communal violence"']
];

/* Most specific category wins when a headline matches several. */
const CATEGORY_WORDS = [
  ['security', /\b(terror\w*|militants?|maoists?|naxal\w*|insurgents?|encounter|ied|grenade|gunfight|infiltrat\w*|ambush)\b/i],
  ['unrest', /\b(riots?|clash(?:es)?|curfew|protests?|mob|lathi|agitation|bandh|prohibitory|section 144|internet shutdown|communal|violence|arson)\b/i],
  ['accident', /\b(explosion|blast|collapse[sd]?|derail\w*|stampede|gas leak|capsiz\w*|fire|accident|crash(?:es|ed)?|tragedy)\b/i],
  ['hazard', /\b(floods?|flooding|cyclon\w*|landslides?|rain\w*|earthquake|tremors?|tsunami|cloudburst|storm|lightning|heat ?wave|drought|dam|inundat\w*|deluge)\b/i]
];

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Places, most specific first: Tamil Nadu and neighbouring districts, Indian cities, then
 * states. Takes the parsed districts.json and india-places.json.
 */
export function buildGazetteer({ districts }, india) {
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
export function seenIso(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(s || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

/** Turns DOC API articles into placed, categorised, de-duplicated items. */
export function normalizeArticles(articles, gazetteer, seed = []) {
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


/** Placed items from a DOC API response body, merged into `previous` and trimmed to 48 hours. */
export function mergeNews(articles, gazetteer, previous = [], now = Date.now()) {
  const kept = previous.filter((x) => now - Date.parse(x.at) < NEWS_KEEP_MS);
  return normalizeArticles(articles, gazetteer, kept)
    .filter((x) => now - Date.parse(x.at) < NEWS_KEEP_MS)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, NEWS_MAX_ITEMS);
}
