import { readFileSync } from 'node:fs';

/**
 * Locates SACHET alerts by district name. SACHET CAP messages carry district
 * names (in areaDesc and the English headline) and LGD codes, but their polygon
 * files are not retrievable by automated clients, so names are the reliable key.
 */

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function loadGazetteer(url = new URL('../data/districts.json', import.meta.url)) {
  const { districts } = JSON.parse(readFileSync(url, 'utf8'));
  return districts.map((d) => ({
    ...d,
    pattern: new RegExp(`\\b(?:${[d.name, ...(d.aliases || [])].map(escapeRegExp).join('|')})\\b`, 'i')
  }));
}

/** Returns gazetteer entries whose name or alias appears as a whole word in the text. */
export function matchPlaces(text, gazetteer) {
  if (!text) return [];
  return gazetteer.filter((d) => d.pattern.test(text)).map(({ name, state, lat, lng }) => ({ name, state, lat, lng }));
}

export function centroidOf(points) {
  if (!points.length) return null;
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
    lng: points.reduce((s, p) => s + p.lng, 0) / points.length
  };
}
