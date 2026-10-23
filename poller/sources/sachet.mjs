import { assertSafeXml, rawElements, firstText, allText, clampText } from '../lib/xml.mjs';
import { parseCapPolygon, parseCapCircle, ringCentroid } from '../lib/geo.mjs';
import { mapLimit, HttpError } from '../lib/http.mjs';
import { loadGazetteer, matchPlaces, centroidOf } from '../lib/places.mjs';

const DEFAULT_GAZETTEER = loadGazetteer();

/**
 * NDMA SACHET publishes Common Alerting Protocol (CAP 1.2) alerts via RSS.
 * Each RSS item links to a CAP XML document. CAP documents are immutable per
 * identifier, so each one is fetched once and kept in state until it expires.
 */

const MAX_NEW_CAP_PER_RUN = 40;
const MAX_ITEMS_PER_FEED = 200;
const SEEN_LINK_TTL_MS = 7 * 24 * 3600 * 1000;

const KIND_PATTERNS = [
  ['dam', /\b(dams?|reservoirs?|spillways?|shutters?|sluices?|crest gates?|surplus (water|discharge)|water release|releas(e|ed|ing) of water|outflow)\b/i],
  ['flood', /\b(floods?|flooding|inundat\w*|flash flood|river|water level|danger level|warning level|overflow\w*)\b/i],
  ['heat', /\b(heat ?waves?|hot and humid|severe heat|high temperature|heat stress)\b/i],
  ['cyclone', /\b(cyclon\w*|depression|deep depression|storm surge)\b/i],
  ['rain', /\b(heavy rain\w*|extremely heavy|very heavy|rainfall)\b/i],
  ['thunderstorm', /\b(thunderstorms?|lightning|squall)\b/i],
  ['tsunami', /\btsunami\b/i]
];

function isTransient(err) {
  if (!(err instanceof HttpError)) return false;
  if (/allowlist|non-https|invalid URL|too large/.test(err.message)) return false;
  return err.status === undefined || err.status === 429 || err.status >= 500;
}

export function classifyKinds(text) {
  const kinds = KIND_PATTERNS.filter(([, re]) => re.test(text)).map(([k]) => k);
  return kinds.length ? kinds : ['other'];
}

export function parseRss(xml) {
  assertSafeXml(xml);
  return rawElements(xml, 'item').slice(0, MAX_ITEMS_PER_FEED).map((item) => ({
    title: clampText(firstText(item, 'title'), 300),
    link: firstText(item, 'link'),
    guid: firstText(item, 'guid') || firstText(item, 'link'),
    pubDate: firstText(item, 'pubDate')
  })).filter((i) => i.link);
}

function pickInfo(infos) {
  const english = infos.find((i) => /^en/i.test(firstText(i, 'language')));
  return english || infos[0] || null;
}

const toIso = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** CAP <geocode> pairs, e.g. LGD district codes. Kept for future code-based matching. */
function parseGeocodes(areaXml) {
  return rawElements(areaXml, 'geocode').map((g) => ({
    name: clampText(firstText(g, 'valueName'), 60),
    value: clampText(firstText(g, 'value'), 60)
  })).filter((g) => g.value).slice(0, 100);
}

export function parseCap(xml, gazetteer = DEFAULT_GAZETTEER) {
  assertSafeXml(xml);
  const [alert] = rawElements(xml, 'alert');
  if (alert === undefined) throw new Error('not a CAP document: <alert> missing');

  const identifier = firstText(alert, 'identifier');
  if (!identifier) throw new Error('CAP alert has no identifier');

  const infos = rawElements(alert, 'info');
  const info = pickInfo(infos);
  if (!info) throw new Error(`CAP alert ${identifier} has no <info>`);

  const areas = rawElements(info, 'area').map((a) => ({
    desc: clampText(firstText(a, 'areaDesc'), 300),
    polygons: allText(a, 'polygon').map((p) => parseCapPolygon(p)).filter(Boolean),
    circles: allText(a, 'circle').map((c) => parseCapCircle(c)).filter(Boolean),
    geocodes: parseGeocodes(a)
  }));

  const polygons = areas.flatMap((a) => a.polygons).slice(0, 50);
  const circles = areas.flatMap((a) => a.circles).slice(0, 50);

  const event = clampText(firstText(info, 'event'), 120);
  const headline = clampText(firstText(info, 'headline'), 300);
  const areaText = areas.map((a) => a.desc).join('; ');

  /* District names: prefer areaDesc. Some alerts only say "10 districts of Kerala" and list
     the districts in the headline; fall back to the headline only for a state the gazetteer
     covers, and keep only that state's districts (a Lakshadweep alert whose headline also
     mentions Kerala must not be placed in Kerala). */
  let places = matchPlaces(areaText, gazetteer);
  if (!places.length) {
    const states = [...areaText.matchAll(/\bof\s+([A-Za-z &]+?)\s*(?:;|$)/g)].map((m) => m[1].trim().toLowerCase());
    if (states.length) {
      places = matchPlaces(headline, gazetteer).filter((p) => states.includes(p.state.toLowerCase()));
    }
  }
  places = places.slice(0, 40);

  const anchor = polygons.length ? ringCentroid(polygons[0])
    : circles[0] ? { lat: circles[0].lat, lng: circles[0].lng }
    : centroidOf(places);
  const description = clampText(firstText(info, 'description'), 2000);
  const instruction = clampText(firstText(info, 'instruction'), 1000);

  return {
    identifier: clampText(identifier, 200),
    sender: clampText(firstText(alert, 'sender'), 200),
    senderName: clampText(firstText(info, 'senderName'), 200),
    sent: toIso(firstText(alert, 'sent')),
    status: firstText(alert, 'status'),
    msgType: firstText(alert, 'msgType'),
    scope: firstText(alert, 'scope'),
    references: clampText(firstText(alert, 'references'), 2000),
    categories: allText(info, 'category').slice(0, 10),
    event,
    urgency: firstText(info, 'urgency'),
    severity: firstText(info, 'severity'),
    certainty: firstText(info, 'certainty'),
    headline,
    description,
    instruction,
    effective: toIso(firstText(info, 'effective')) || toIso(firstText(alert, 'sent')),
    onset: toIso(firstText(info, 'onset')),
    expires: toIso(firstText(info, 'expires')),
    web: clampText(firstText(info, 'web'), 500),
    areaDesc: clampText(areas.map((a) => a.desc).filter(Boolean).join('; '), 600),
    polygons,
    circles,
    places,
    geocodes: areas.flatMap((a) => a.geocodes).slice(0, 100),
    locatedBy: polygons.length || circles.length ? 'geometry' : places.length ? 'district-names' : 'none',
    lat: anchor ? anchor.lat : null,
    lng: anchor ? anchor.lng : null,
    kinds: classifyKinds(`${event} ${headline} ${description}`)
  };
}

/**
 * Refreshes the set of active SACHET alerts.
 *   prev:      { [identifier]: alert } carried over from the last run.
 *   seenLinks: { [capUrl]: epochMs } of CAP documents already fetched, including
 *              ones rejected as tests or expired, so nothing is downloaded twice.
 * Returns { active, seenLinks, fetched, errors, feedsOk }.
 */
export async function fetchSachet({ http, feeds, prev = {}, seenLinks = {}, now = Date.now(), log = () => {} }) {
  const active = {};
  for (const [id, a] of Object.entries(prev)) {
    if (!a.expires || Date.parse(a.expires) > now) active[id] = a;
  }
  const seen = {};
  for (const [link, ts] of Object.entries(seenLinks)) {
    if (now - ts < SEEN_LINK_TTL_MS) seen[link] = ts;
  }
  for (const a of Object.values(active)) seen[a.link] = seen[a.link] || now;

  const feedResults = await mapLimit(feeds, 3, (url) => http.getText(url, { conditional: true }));
  const errors = [];
  const items = [];
  let feedsOk = 0;
  let unchanged = 0;
  feedResults.forEach((r, i) => {
    if (!r.ok) {
      errors.push(`${feeds[i]}: ${r.error.message}`);
      return;
    }
    feedsOk++;
    if (r.value.notModified) {
      unchanged++;
      return;
    }
    try {
      items.push(...parseRss(r.value.text));
    } catch (err) {
      errors.push(`${feeds[i]}: ${err.message}`);
    }
  });

  const fresh = [...new Map(items.filter((i) => !Object.hasOwn(seen, i.link)).map((i) => [i.link, i])).values()]
    .slice(0, MAX_NEW_CAP_PER_RUN);
  const capResults = await mapLimit(fresh, 4, async (item) => {
    const { text } = await http.getText(item.link);
    return { ...parseCap(text), link: item.link };
  });

  let fetched = 0;
  const superseded = new Set();
  capResults.forEach((r, i) => {
    if (!r.ok) {
      errors.push(`CAP ${fresh[i].link}: ${r.error.message}`);
      /* Retry only transient failures; a hostile, malformed or blocked document is remembered and skipped. */
      if (!isTransient(r.error)) seen[fresh[i].link] = now;
      return;
    }
    seen[fresh[i].link] = now;
    const a = r.value;
    if (a.status !== 'Actual') return;
    if (a.expires && Date.parse(a.expires) <= now) return;
    fetched++;
    /* CAP references are "sender,identifier,sent" triples. Updates and cancels supersede them. */
    if (a.msgType === 'Update' || a.msgType === 'Cancel') {
      for (const ref of a.references.split(/\s+/)) {
        const refId = ref.split(',')[1];
        if (refId && refId !== a.identifier) superseded.add(refId);
      }
    }
    if (a.msgType === 'Cancel') return;
    active[a.identifier] = a;
  });

  for (const id of superseded) delete active[id];

  log(`sachet: ${feedsOk}/${feeds.length} feeds ok (${unchanged} unchanged), ${fresh.length} new items, ${fetched} CAP alerts accepted, ${Object.keys(active).length} active`);
  return { active, seenLinks: seen, fetched, errors, feedsOk };
}
