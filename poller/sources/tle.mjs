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

/** Returns null when the previous snapshot is fresh enough; otherwise the groups. */
export async function fetchTle({ http, lastFetchedAt = 0, now = Date.now(), minIntervalMs = TLE_MIN_INTERVAL_MS }) {
  if (now - lastFetchedAt < minIntervalMs) return null;
  const groups = [];
  for (const g of TLE_GROUPS) {
    const { text } = await http.getText(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g.group}&FORMAT=tle`, { timeoutMs: 45000 });
    const tle = cleanTle(text);
    if (!tle) throw new Error(`CelesTrak returned no valid TLEs for ${g.group}`);
    groups.push({ tag: g.tag, tle });
  }
  return groups;
}
