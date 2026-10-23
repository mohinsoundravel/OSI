/**
 * Satellite orbital elements (TLEs) from CelesTrak, republished for the dashboard.
 *
 * Browsers on some networks time out fetching CelesTrak directly, and CelesTrak
 * asks clients not to re-download the same data more often than every two hours.
 * The poller fetches at most every MIN_INTERVAL_MS and publishes tle.json; the
 * dashboard propagates positions locally with SGP4.
 */

export const TLE_MIN_INTERVAL_MS = 6 * 3600 * 1000;
export const TLE_GROUPS = [
  { group: 'stations', tag: 'Space stations' },
  { group: 'visual', tag: 'Brightest' }
];

const MAX_SATS_PER_GROUP = 400;

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

/* CelesTrak is unreliable from GitHub's runners (network failures, HTTP 500); AMSAT's
   current-TLE file (ISS plus amateur and science satellites) is the fallback. */
const AMSAT_URL = 'https://www.amsat.org/tle/current/nasabare.txt';

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
