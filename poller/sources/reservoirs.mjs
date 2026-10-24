/**
 * Daily reservoir levels for the Cauvery, Vaigai, Thamirabarani, Pennaiyar and
 * Parambikulam-Aliyar systems, from the Tamil Nadu Agriculture Department's
 * public "Storage and Flow Data on Major Reservoirs" page (data from the Water
 * Resources Department). It also lists the Karnataka dams (KRS, Kabini, Harangi,
 * Hemavathy) whose releases reach Mettur a day or two later.
 *
 * The page is HTML with one card per reservoir: full depth (ft), current level (ft),
 * inflow and outflow (cusecs), plus one "As On Date" for the whole page. Appending
 * YYYY-MM-DD to the URL gives an earlier day, used for day-over-day changes.
 * Verified from a GitHub runner (diagnose task, 2026-10-24).
 *
 * Limits: one daily figure per dam (no intraday data); a single unofficial-format
 * page (layout changes break the parser, which then fails loudly); dam positions
 * below are approximate.
 */

export const RESERVOIR_URL = 'https://tnagriculture.in/people_app/more/reservoir/en/';
export const RESERVOIR_MIN_INTERVAL_MS = 60 * 60 * 1000;

/* Approximate dam positions. `releaseHigh` is the outflow (cusecs) treated as a
   large, flood-type release for that dam; routine irrigation releases stay below it. */
export const RESERVOIR_SITES = {
  mettur: { name: 'Mettur (Stanley)', river: 'Cauvery', state: 'Tamil Nadu', lat: 11.80, lng: 77.81, releaseHigh: 30000 },
  krs: { name: 'Krishna Raja Sagar', river: 'Cauvery', state: 'Karnataka', lat: 12.42, lng: 76.57, releaseHigh: 30000 },
  kabini: { name: 'Kabini', river: 'Kabini', state: 'Karnataka', lat: 11.97, lng: 76.35, releaseHigh: 30000 },
  harangi: { name: 'Harangi', river: 'Harangi', state: 'Karnataka', lat: 12.49, lng: 75.91, releaseHigh: 15000 },
  hemavathy: { name: 'Hemavathy', river: 'Hemavathi', state: 'Karnataka', lat: 12.82, lng: 76.06, releaseHigh: 20000 },
  bhavanisagar: { name: 'Bhavanisagar', river: 'Bhavani', state: 'Tamil Nadu', lat: 11.47, lng: 77.11, releaseHigh: 15000 },
  amaravathi: { name: 'Amaravathi', river: 'Amaravathi', state: 'Tamil Nadu', lat: 10.41, lng: 77.26, releaseHigh: 10000 },
  periyar: { name: 'Periyar (Mullaperiyar)', river: 'Periyar', state: 'Kerala (TN-operated)', lat: 9.53, lng: 77.14, releaseHigh: 10000 },
  vaigai: { name: 'Vaigai', river: 'Vaigai', state: 'Tamil Nadu', lat: 10.05, lng: 77.59, releaseHigh: 7000 },
  papanasam: { name: 'Papanasam', river: 'Thamirabarani', state: 'Tamil Nadu', lat: 8.71, lng: 77.37, releaseHigh: 10000 },
  manimuthar: { name: 'Manimuthar', river: 'Manimuthar', state: 'Tamil Nadu', lat: 8.65, lng: 77.43, releaseHigh: 8000 },
  pechiparai: { name: 'Pechiparai', river: 'Kodayar', state: 'Tamil Nadu', lat: 8.43, lng: 77.30, releaseHigh: 8000 },
  perunchani: { name: 'Perunchani', river: 'Paralayar', state: 'Tamil Nadu', lat: 8.39, lng: 77.35, releaseHigh: 8000 },
  krishnagiri: { name: 'Krishnagiri (KRP)', river: 'Thenpennai', state: 'Tamil Nadu', lat: 12.47, lng: 78.18, releaseHigh: 5000 },
  sathanur: { name: 'Sathanur', river: 'Thenpennai', state: 'Tamil Nadu', lat: 12.18, lng: 78.86, releaseHigh: 10000 },
  sholayar: { name: 'Sholayar', river: 'Chalakudy', state: 'Tamil Nadu', lat: 10.30, lng: 76.73, releaseHigh: 8000 },
  parambikulam: { name: 'Parambikulam', river: 'Parambikulam', state: 'Kerala (TN-operated)', lat: 10.39, lng: 76.78, releaseHigh: 8000 },
  aliyar: { name: 'Aliyar', river: 'Aliyar', state: 'Tamil Nadu', lat: 10.48, lng: 76.97, releaseHigh: 8000 },
  thirumurthy: { name: 'Thirumurthy', river: 'Palar (Udumalai)', state: 'Tamil Nadu', lat: 10.46, lng: 77.18, releaseHigh: 8000 }
};

const ALIASES = { 'krishna-raja-sagar': 'krs', 'krishnaraja-sagar': 'krs', 'stanley': 'mettur', 'mullaperiyar': 'periyar', 'hemavathi': 'hemavathy' };

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const clean = (s) => decode(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Stable id from a page label such as "Papanasam          (TN EB Dam)" or "AMARAVATHI*". */
export function reservoirId(label) {
  const slug = clean(label).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z]+/g, '-').replace(/^-+|-+$/g, '');
  return ALIASES[slug] || slug;
}

function toNumber(text) {
  const t = clean(text).replace(/,/g, '');
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** Parses the page into { date: 'YYYY-MM-DD', items: [...] }. Throws when the layout is unrecognised. */
export function parseReservoirPage(html) {
  const text = String(html).slice(0, 2_000_000);
  const dm = /As On Date:\s*<\/span>\s*<span[^>]*>\s*(\d{2})-(\d{2})-(\d{4})/i.exec(text);
  if (!dm) throw new Error('reservoir page: "As On Date" not found (layout changed?)');
  const date = `${dm[3]}-${dm[2]}-${dm[1]}`;
  const items = [];
  const blocks = text.split(/<h4[^>]*class="[^"]*date-tt[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    const end = block.indexOf('</h4>');
    if (end < 0) continue;
    const label = clean(block.slice(0, end));
    const lists = [...block.matchAll(/<ul[^>]*class="[^"]*leg1[^"]*"[^>]*>([\s\S]*?)<\/ul>/gi)].map((m) => m[1]);
    if (lists.length < 3 || !/full depth/i.test(lists[0])) continue;
    const values = [...lists[2].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => toNumber(m[1]));
    const [fullFt, levelFt, inflow, outflow] = values;
    const id = reservoirId(label);
    if (!id || !Number.isFinite(fullFt) || fullFt <= 0 || fullFt > 1000) continue;
    const ok = (v, max) => (Number.isFinite(v) && v >= 0 && v <= max ? v : null);
    items.push({
      id,
      label: label.slice(0, 60),
      fullFt,
      levelFt: ok(levelFt, fullFt * 1.3),
      inflow: ok(inflow, 2_000_000),
      outflow: ok(outflow, 2_000_000)
    });
  }
  if (!items.length) throw new Error('reservoir page: no reservoirs parsed (layout changed?)');
  return { date, items };
}

const previousDay = (isoDate) => new Date(Date.parse(`${isoDate}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

/**
 * Fetches the latest page at most every minIntervalMs, plus the previous day's page
 * once per new date. Returns null when the last snapshot is still fresh.
 */
export async function fetchReservoirs({ http, lastFetchedAt = 0, known = [], now = Date.now(), minIntervalMs = RESERVOIR_MIN_INTERVAL_MS }) {
  if (now - lastFetchedAt < minIntervalMs) return null;
  const { text } = await http.getText(RESERVOIR_URL, { timeoutMs: 30000 });
  const current = parseReservoirPage(text);
  const wantPrev = previousDay(current.date);
  /* Yesterday's page is usually already known: it was 'current' until the date advanced. */
  let previous = known.find((s) => s && s.date === wantPrev) || null;
  if (!previous) {
    try {
      const { text: prevText } = await http.getText(`${RESERVOIR_URL}${wantPrev}`, { timeoutMs: 30000 });
      const parsed = parseReservoirPage(prevText);
      if (parsed.date === wantPrev) previous = parsed;
    } catch {
      previous = null;   /* day-over-day changes are optional */
    }
  }
  return { current, previous };
}

/** Joins today's figures with yesterday's and the site table, for rules and the dashboard. */
export function reservoirLayer(snapshot) {
  if (!snapshot || !snapshot.current) return { date: null, prevDate: null, items: [] };
  const prev = new Map((snapshot.previous?.items || []).map((p) => [p.id, p]));
  const items = snapshot.current.items.map((r) => {
    const site = RESERVOIR_SITES[r.id] || null;
    const p = prev.get(r.id);
    const delta = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? Math.round((a - b) * 100) / 100 : null);
    return {
      id: r.id,
      name: site ? site.name : r.label,
      river: site ? site.river : null,
      state: site ? site.state : null,
      lat: site ? site.lat : null,
      lng: site ? site.lng : null,
      fullFt: r.fullFt,
      levelFt: r.levelFt,
      pctDepth: Number.isFinite(r.levelFt) ? Math.round((r.levelFt / r.fullFt) * 1000) / 10 : null,
      inflow: r.inflow,
      outflow: r.outflow,
      levelChangeFt: delta(r.levelFt, p?.levelFt),
      outflowChange: delta(r.outflow, p?.outflow),
      prevOutflow: p ? p.outflow : null,
      releaseHigh: site ? site.releaseHigh : 20000
    };
  });
  return { date: snapshot.current.date, prevDate: snapshot.previous?.date || null, source: RESERVOIR_URL, items };
}

/**
 * Reservoir rules (derived from official daily figures):
 *  - Release: outflow at or above the dam's large-release mark is high (twice that is
 *    critical); a jump of at least 5,000 cusecs and 50% over the previous day is medium,
 *    which is how a gate opening usually shows up in daily data.
 *  - Near full: within 3 ft of full depth is medium (surplus release likely); within
 *    0.5 ft is high.
 */
export function assessReservoir(r) {
  const out = [];
  if (Number.isFinite(r.outflow)) {
    const high = r.releaseHigh || 20000;
    let severity = null;
    if (r.outflow >= 2 * high) severity = 'critical';
    else if (r.outflow >= high) severity = 'high';
    else if (Number.isFinite(r.prevOutflow) && r.outflow - r.prevOutflow >= 5000 && r.outflow >= 1.5 * Math.max(r.prevOutflow, 1)) severity = 'medium';
    if (severity) out.push({ type: 'release', severity });
  }
  if (Number.isFinite(r.levelFt)) {
    const gap = r.fullFt - r.levelFt;
    if (gap <= 0.5) out.push({ type: 'full', severity: 'high' });
    else if (gap <= 3) out.push({ type: 'full', severity: 'medium' });
  }
  return out;
}
