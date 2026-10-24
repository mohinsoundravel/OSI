/**
 * Satellite orbital elements (TLEs) from CelesTrak, republished for the dashboard.
 *
 * Browsers on some networks time out fetching CelesTrak directly, and CelesTrak
 * asks clients not to re-download the same data more often than every two hours.
 * The poller fetches at most every MIN_INTERVAL_MS and publishes tle.json; the
 * dashboard propagates positions locally with SGP4.
 */

export const TLE_MIN_INTERVAL_MS = 6 * 3600 * 1000;
/* Every active satellite CelesTrak tracks (about 16,000 in late 2026, two thirds Starlink). */
export const TLE_GROUPS = [
  { group: 'active', tag: 'Active satellites' }
];

const MAX_SATS_PER_GROUP = 25000;

/** Keeps only well-formed three-line records (name, line 1, line 2). */
export function cleanTle(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  const out = [];
  for (let i = 0; i + 2 < lines.length && out.length < MAX_SATS_PER_GROUP * 3; i++) {
    const [name, l1, l2] = [lines[i], lines[i + 1], lines[i + 2]];
    if (/^1 \d{5}/.test(l1) && /^2 \d{5}/.test(l2) && l1.length >= 68 && l2.length >= 68 && !/^[12] \d{5}/.test(name)) {
      out.push(name.trim().slice(0, 40), l1.slice(0, 69), l2.slice(0, 69));
      i += 2;
    }
  }
  return out.join('\n');
}

/* CelesTrak has been unreliable from GitHub's runners at times (network failures, HTTP 500).
   Fallbacks: SatNOGS (about 1,700 amateur and science satellites), then AMSAT's current file. */
const AMSAT_URL = 'https://www.amsat.org/tle/current/nasabare.txt';
const SATNOGS_URL = 'https://db.satnogs.org/api/tle/?format=json';

/** SatNOGS returns [{tle0: "0 NAME", tle1, tle2}]; converts to plain three-line text. */
export function satnogsToTle(json) {
  if (!Array.isArray(json)) return '';
  return json.slice(0, MAX_SATS_PER_GROUP)
    .filter((r) => r && typeof r.tle1 === 'string' && typeof r.tle2 === 'string')
    .map((r) => `${String(r.tle0 || '').replace(/^0 /, '') || r.tle1.slice(2, 7)}\n${r.tle1}\n${r.tle2}`).join('\n');
}

/** Returns null when the previous snapshot is fresh enough; otherwise the groups. */
export async function fetchTle({ http, lastFetchedAt = 0, now = Date.now(), minIntervalMs = TLE_MIN_INTERVAL_MS, log = () => {} }) {
  if (now - lastFetchedAt < minIntervalMs) return null;
  const groups = [];
  const errors = [];
  for (const g of TLE_GROUPS) {
    try {
      const { text } = await http.getText(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g.group}&FORMAT=tle`, { timeoutMs: 45000 });
      const tle = cleanTle(text);
      if (tle) groups.push({ tag: g.tag, tle, source: 'CelesTrak' });
      else errors.push(`CelesTrak ${g.group}: no valid TLEs`);
    } catch (err) {
      errors.push(`CelesTrak ${g.group}: ${err.message}`);
    }
  }
  if (!groups.length) {
    try {
      const { json } = await http.getJson(SATNOGS_URL, { timeoutMs: 45000 });
      const tle = cleanTle(satnogsToTle(json));
      if (tle) groups.push({ tag: 'SatNOGS (amateur and science satellites)', tle, source: 'SatNOGS' });
      else errors.push('SatNOGS: no valid TLEs');
    } catch (err) {
      errors.push(`SatNOGS: ${err.message}`);
    }
  }
  if (!groups.length) {
    try {
      const { text } = await http.getText(AMSAT_URL, { timeoutMs: 45000 });
      const tle = cleanTle(text);
      if (tle) groups.push({ tag: 'AMSAT (ISS, amateur and science satellites)', tle, source: 'AMSAT' });
      else errors.push('AMSAT: no valid TLEs');
    } catch (err) {
      errors.push(`AMSAT: ${err.message}`);
    }
  }
  if (errors.length) log(`tle: ${errors.join('; ')}`);
  if (!groups.length) throw new Error(errors.join('; ').slice(0, 280));
  return groups;
}
