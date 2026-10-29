import { zonesForArea, zonesForPoint } from './lib/geo.mjs';
import { assessRiver, assessHeat, assessRain } from './sources/openmeteo.mjs';
import { assessReservoir } from './sources/reservoirs.mjs';
import { assessSea } from './sources/marine.mjs';
import { assessFires } from './sources/fires.mjs';
import { closestApproach } from './sources/cyclones.mjs';

export const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

const CAP_SEVERITY = { Extreme: 'critical', Severe: 'high', Moderate: 'medium', Minor: 'low', Unknown: 'medium' };
const KIND_LABEL = {
  dam: 'Dam / reservoir release', flood: 'Flood', heat: 'Heat wave', cyclone: 'Cyclone',
  rain: 'Heavy rain', thunderstorm: 'Thunderstorm', tsunami: 'Tsunami', other: 'Alert'
};

/** Most specific kind first: a dam-release alert is also usually a flood alert. */
const KIND_PRIORITY = ['tsunami', 'dam', 'flood', 'cyclone', 'heat', 'rain', 'thunderstorm', 'other'];
const primaryKind = (kinds) => KIND_PRIORITY.find((k) => kinds.includes(k)) || 'other';

const zoneNames = (zs) => zs.map((z) => z.name);

/**
 * IMD issues rain and thunderstorm nowcasts several times a day, often tagged
 * CAP "Severe". Mapping those straight to high severity would page the owner
 * for routine weather, so rain/thunderstorm alerts are scaled down unless the
 * wording or CAP severity indicates exceptional rain. Hazards that threaten
 * life or property directly (flood, dam release, heat, cyclone, tsunami) keep
 * the issuing agency's severity.
 */
const ROUTINE_KINDS = new Set(['rain', 'thunderstorm', 'other']);

export function sachetSeverity(a, kind) {
  const base = CAP_SEVERITY[a.severity] || 'medium';
  if (!ROUTINE_KINDS.has(kind)) return base;
  if (a.severity === 'Extreme' || /extremely heavy/i.test(`${a.event} ${a.headline}`)) return 'high';
  if (/very heavy/i.test(`${a.event} ${a.headline}`)) return 'medium';
  return 'low';
}

/** Zones touched by an alert: real geometry when present, otherwise the positions of named districts. */
function sachetZones(a, zones) {
  const hit = new Map(zonesForArea(a, zones).map((z) => [z.id, z]));
  for (const place of a.places || []) {
    for (const z of zonesForPoint(place.lat, place.lng, zones)) hit.set(z.id, z);
  }
  return [...hit.values()];
}

/**
 * Every rule returns candidate alerts with a stable `key`. A key is notified at
 * most once per de-duplication window; escalations get a new key because the
 * severity or level is part of it.
 */
export function evaluate({ config, data, normals, now = Date.now() }) {
  const zones = config.zones;
  const out = [];

  /* Official: SACHET CAP alerts (IMD, state disaster authorities, INCOIS ...). */
  const sachetScope = config.sachet?.scope || 'zones';
  for (const a of Object.values(data.sachet || {})) {
    if (a.urgency === 'Past') continue;
    const hit = sachetZones(a, zones);
    if (sachetScope === 'zones' && !hit.length) continue;
    const kind = primaryKind(a.kinds);
    const severity = sachetSeverity(a, kind);
    out.push({
      key: `sachet:${a.identifier}`,
      rule: 'sachet_official', origin: 'official', kind, severity,
      title: `${KIND_LABEL[kind]}: ${a.areaDesc || a.event || 'India'}`,
      summary: a.headline || a.description.slice(0, 280),
      instruction: a.instruction || null,
      source: a.senderName || a.sender || 'SACHET',
      sourceUrl: a.link,
      lat: a.lat, lng: a.lng, polygons: a.polygons, circles: a.circles, places: a.places || [],
      zones: zoneNames(hit), effective: a.effective, expires: a.expires,
      capSeverity: a.severity, urgency: a.urgency, certainty: a.certainty
    });
  }

  /* Derived: river discharge forecast (GloFAS via Open-Meteo). */
  for (const r of data.rivers || []) {
    const verdict = assessRiver(r, config.flood);
    if (!verdict) continue;
    out.push({
      key: `river:${r.id}:${verdict.severity}`,
      rule: 'river_discharge', origin: 'derived', kind: 'flood', severity: verdict.severity,
      title: `River rise forecast: ${r.name}`,
      summary: `${verdict.reason}; peak expected ${r.peakDate}. Model forecast, not an official warning.`,
      source: 'GloFAS via Open-Meteo', sourceUrl: 'https://open-meteo.com/en/docs/flood-api',
      lat: r.lat, lng: r.lng, zones: zoneNames(zonesForPoint(r.lat, r.lng, zones))
    });
  }

  /* Derived: heat wave per IMD station criteria on forecast maxima. */
  for (const p of data.heat || []) {
    const { alert } = assessHeat(p, normals?.[p.id]);
    if (!alert) continue;
    const normalNote = Number.isFinite(alert.normal) ? `, normal ${alert.normal} C` : ', no climate normal available (absolute criterion only)';
    out.push({
      key: `heat:${p.id}:${alert.severity}:${alert.from}`,
      rule: 'heat_imd_criteria', origin: 'derived', kind: 'heat', severity: alert.severity,
      title: `${alert.label} forecast: ${p.name}`,
      summary: `Max ${alert.tmax} C on ${alert.from} to ${alert.to}${normalNote}. Forecast meets IMD station criteria; not an IMD declaration.`,
      source: 'Open-Meteo forecast, IMD criteria', sourceUrl: 'https://open-meteo.com/en/docs',
      lat: p.lat, lng: p.lng, zones: zoneNames(zonesForPoint(p.lat, p.lng, zones))
    });
  }

  /* Derived: very heavy or extremely heavy rain forecast for a district (IMD 24-hour categories). */
  for (const r of data.rain || []) {
    const v = assessRain(r);
    if (!v || !Number.isFinite(r.lat)) continue;
    const hit = zonesForPoint(r.lat, r.lng, zones);
    if (!hit.length) continue;
    out.push({
      key: `rain:${r.id}:${v.severity}:${r.peakDate}`,
      rule: 'rain_imd_category', origin: 'derived', kind: 'rain', severity: v.severity,
      title: `${v.label} forecast: ${r.name}`,
      summary: `${r.peakMm} mm forecast on ${r.peakDate} (3-day total ${r.next72} mm). IMD 24-hour category applied to a model forecast; not an IMD warning.`,
      source: 'Open-Meteo forecast, IMD categories', sourceUrl: 'https://open-meteo.com/en/docs',
      lat: r.lat, lng: r.lng, zones: zoneNames(hit)
    });
  }

  /* Derived from official daily figures: large or sharply increased dam releases, and
     reservoirs near full (a surplus release usually follows). */
  const fmt = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-IN') : '?');
  for (const r of data.reservoirs?.items || []) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng)) continue;
    const hit = zonesForPoint(r.lat, r.lng, zones);
    if (!hit.length) continue;
    for (const v of assessReservoir(r)) {
      const levelText = `level ${r.levelFt ?? '?'} of ${r.fullFt} ft${Number.isFinite(r.levelChangeFt) ? ` (${r.levelChangeFt >= 0 ? '+' : ''}${r.levelChangeFt} ft in a day)` : ''}`;
      const flowText = `inflow ${fmt(r.inflow)}, outflow ${fmt(r.outflow)} cusecs${Number.isFinite(r.prevOutflow) ? ` (was ${fmt(r.prevOutflow)})` : ''}`;
      out.push({
        key: `reservoir:${r.id}:${v.type}:${v.severity}`,
        rule: v.type === 'release' ? 'reservoir_release' : 'reservoir_full', origin: 'derived', kind: 'dam', severity: v.severity,
        title: v.type === 'release' ? `Large release: ${r.name} dam` : `Near full: ${r.name} dam`,
        summary: `${r.river ? `${r.river}, ` : ''}${levelText}; ${flowText}, as on ${data.reservoirs.date}. ${v.type === 'release' ? 'Downstream river levels may rise.' : 'Surplus release likely if inflow continues.'} Daily WRD figures; not an official flood warning.`,
        source: 'TN Agriculture Dept (WRD reservoir data)', sourceUrl: data.reservoirs.source,
        lat: r.lat, lng: r.lng, zones: zoneNames(hit)
      });
    }
  }

  /* Earthquakes from any source share one zone policy (see USGS below): a large circle
     over India also covers Tibet, so ordinary quakes use only usgs.zones. */
  const quakeZoneIds = new Set(config.usgs?.zones || zones.map((z) => z.id));
  const quakeZones = zones.filter((z) => quakeZoneIds.has(z.id));

  /* Official: GDACS Orange/Red inside zones. Cyclones and floods use every zone, since a
     Bay of Bengal cyclone matters well before landfall. */
  const minGdacs = config.gdacs?.minLevel || 'Orange';
  const levelRank = { Green: 0, Orange: 1, Red: 2 };
  for (const e of data.gdacs || []) {
    if (levelRank[e.alertLevel] < levelRank[minGdacs]) continue;
    const hit = zonesForPoint(e.lat, e.lng, e.type === 'Earthquake' ? quakeZones : zones);
    if (!hit.length) continue;
    out.push({
      key: `gdacs:${e.id}:${e.alertLevel}`,
      rule: 'gdacs_level', origin: 'official', kind: e.type === 'Flood' ? 'flood' : e.type === 'Tropical cyclone' ? 'cyclone' : 'other',
      severity: e.alertLevel === 'Red' ? 'critical' : 'high',
      title: `GDACS ${e.alertLevel}: ${e.type} ${e.name}`,
      summary: `${e.type} alert for ${e.country || 'the region'}.`,
      source: 'GDACS', sourceUrl: e.url, lat: e.lat, lng: e.lng, zones: zoneNames(hit)
    });
  }

  /* Official: USGS earthquakes. Large zones (a 2,200 km circle over India also covers
     Tibet) make every regional quake "in zone", so ordinary quakes use only the zones
     listed in usgs.zones; tsunami-flagged quakes count in any zone because their
     impact travels across the ocean. */
  const minMag = config.usgs?.minMagnitude ?? 4.5;
  for (const q of data.quakes || []) {
    const hit = zonesForPoint(q.lat, q.lng, q.tsunami ? zones : quakeZones);
    if (!hit.length || (q.mag < minMag && !q.tsunami)) continue;
    out.push({
      key: `usgs:${q.id}`,
      rule: 'usgs_quake', origin: 'official', kind: q.tsunami ? 'tsunami' : 'earthquake',
      severity: q.tsunami || q.mag >= 6.5 ? 'critical' : q.mag >= 5.5 ? 'high' : 'medium',
      title: `M${q.mag.toFixed(1)} earthquake: ${q.place}`,
      summary: `Depth ${Number.isFinite(q.depthKm) ? q.depthKm.toFixed(0) : '?'} km.${q.tsunami ? ' USGS tsunami flag set.' : ''}`,
      source: 'USGS', sourceUrl: q.url, lat: q.lat, lng: q.lng, zones: zoneNames(hit)
    });
  }

  /* Derived from a forecast track: a North Indian Ocean cyclone forecast to pass near the
     watched coast (closest approach to any sea-state point), with estimated landfall. */
  const istText = (iso) => {
    const d = new Date(Date.parse(iso) + 5.5 * 3600 * 1000);
    return Number.isFinite(d.getTime()) ? `${d.toISOString().slice(8, 10)}/${d.toISOString().slice(5, 7)} ${d.toISOString().slice(11, 16)} IST` : '?';
  };
  const coastPlaces = config.cyclones?.places || config.sea?.points || [];
  const withinKm = config.cyclones?.withinKm ?? 400;
  for (const c of data.cyclones || []) {
    if (!c.track?.length || !coastPlaces.length) continue;
    const near = closestApproach(c.track, coastPlaces);
    if (!near || near.km > withinKm) continue;
    /* Once the closest approach is more than 6 hours past, the storm is no longer approaching. */
    if (Date.parse(near.at) < now - 6 * 3600 * 1000) continue;
    /* Distance decides severity; GDACS level changes are already alerted by the GDACS rule. */
    const tier = near.km <= 150 ? 150 : near.km <= 300 ? 300 : withinKm;
    const severity = tier === 150 ? 'high' : 'medium';
    const landfall = c.landfall ? ` Estimated landfall near ${c.landfall.near} around ${istText(c.landfall.at)}.` : '';
    out.push({
      key: `cyclone:${c.eventId}:${tier}`,
      rule: 'cyclone_track', origin: 'derived', kind: 'cyclone', severity,
      title: `Cyclone ${c.name}: forecast within ${near.km} km of ${near.place}`,
      summary: `${c.severityText || 'Tropical cyclone'} (GDACS ${c.alertLevel}). Closest approach about ${istText(near.at)}.${landfall} ${c.source} forecast track via GDACS; follow IMD/RSMC New Delhi bulletins for official warnings.`,
      source: `GDACS (${c.source} track)`, sourceUrl: c.url || 'https://www.gdacs.org',
      lat: c.lat, lng: c.lng, zones: zoneNames(zonesForPoint(c.lat, c.lng, zones))
    });
  }

  /* Derived: rough or very rough sea forecast along the coast (one alert for the coast). */
  const sea = assessSea(data.sea || [], config.sea);
  if (sea) {
    out.push({
      key: `sea:coast:${sea.severity}:${sea.date}`,
      rule: 'sea_state', origin: 'derived', kind: 'sea', severity: sea.severity,
      title: `${sea.severity === 'high' ? 'Very rough' : 'Rough'} sea forecast: ${sea.worst.name} ${sea.worst.peakM} m`,
      summary: `Maximum wave height on ${sea.date}: ${sea.points.slice(0, 6).join(', ')}. Wave model forecast (Open-Meteo Marine), not an INCOIS warning.`,
      source: 'Open-Meteo Marine', sourceUrl: 'https://open-meteo.com/en/docs/marine-weather-api',
      lat: sea.worst.lat, lng: sea.worst.lng, zones: zoneNames(zonesForPoint(sea.worst.lat, sea.worst.lng, zones))
    });
  }

  /* Derived: satellite hotspots clustered in a watched forest area. */
  for (const f of assessFires(data.fires || [], config.fires?.areas || [], config.fires)) {
    out.push({
      key: `fire:${f.area.id}:${f.severity}:${String(f.latest).slice(0, 10)}`,
      rule: 'forest_fire', origin: 'derived', kind: 'fire', severity: f.severity,
      title: `Fire hotspots: ${f.area.name} (${f.count} in 24 h)`,
      summary: `${f.count} VIIRS detections within ${f.area.radiusKm} km, total radiative power ${f.totalFrpMw} MW, latest ${f.latest.slice(0, 16).replace('T', ' ')} UTC. Hotspots can also be crop burning or other heat sources.`,
      source: 'NASA FIRMS (VIIRS)', sourceUrl: 'https://firms.modaps.eosdis.nasa.gov/map/',
      lat: f.lat, lng: f.lng, zones: zoneNames(zonesForPoint(f.lat, f.lng, zones))
    });
  }

  /* Observed: aircraft squawking an emergency code inside a zone (from the latest flight snapshot). */
  const SQUAWK = { 7500: ['critical', 'hijack'], 7700: ['high', 'general emergency'], 7600: ['medium', 'radio failure'] };
  for (const f of data.squawks || []) {
    const meaning = SQUAWK[f.squawk];
    if (!meaning || !Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue;
    const hit = zonesForPoint(f.lat, f.lng, zones);
    if (!hit.length) continue;
    out.push({
      key: `squawk:${f.icao24}:${f.squawk}`,
      rule: 'flight_squawk', origin: 'official', kind: 'aviation', severity: meaning[0],
      title: `Squawk ${f.squawk} (${meaning[1]}): ${f.callsign || f.icao24}`,
      summary: `Aircraft from ${f.country || 'unknown country'}${Number.isFinite(f.baroAltM) ? ` at ${Math.round(f.baroAltM)} m` : ''}. Transponder data via OpenSky; position may be up to 30 minutes old.`,
      source: 'OpenSky Network', sourceUrl: `https://globe.adsbexchange.com/?icao=${encodeURIComponent(f.icao24)}`,
      lat: f.lat, lng: f.lng, zones: zoneNames(hit)
    });
  }

  return out;
}
