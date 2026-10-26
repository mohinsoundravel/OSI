/** Source fetchers: each returns normalised items ({ id, lat, lng, altKm, ... }) for one layer. */
import { appState } from './app-state.js';
import {
  EMERGENCY_SQUAWKS, GDACS_COLOR, SEV_COLOR, fetchWithTimeout, getJson, hexToRgb, satLibOk, store
} from './core.js';
import {
  WEBCAM_LIMIT_PER_ZONE, WEBCAM_MAX_RADIUS_KM, backendBase, fetchBackendAlerts, liveStreamItems,
  windyPlayerEmbed
} from './layers.js';
import { parseFlightSnapshot, parseShipSnapshot, projectFlights, projectShips } from './snapshots.js';
import { loadAllSatellites } from './satellites.js';
import { fetchCycloneItems, fetchFireItems, fetchNewsItems, fetchSeaItems } from './hazards.js';

export function flightColor(squawk, onGround, verticalRate) {
  if (squawk && EMERGENCY_SQUAWKS.includes(squawk)) return hexToRgb(SEV_COLOR.critical);
  if (onGround) return hexToRgb('#5a6472');
  if (verticalRate !== null && Math.abs(verticalRate) > 2) return hexToRgb('#ffb454');
  return hexToRgb('#7fd8c0');
}
export let FETCHERS;

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  FETCHERS = {
    async flights() {
      /* Preferred: the poller's snapshot (OpenSky blocks direct browser access from other sites). */
      const base = backendBase();
      if (base) {
        const snap = await getJson(`${base.replace(/\/+$/, '')}/flights.json`);
        appState.flightSnapshot = parseFlightSnapshot(snap);
        return projectFlights();
      }
      const data = await getJson('https://opensky-network.org/api/states/all');
      return (data.states || [])
        .filter((s) => s[5] !== null && s[6] !== null)
        .map((s) => ({
          id: s[0], callsign: (s[1] || '').trim() || 'N/A', country: s[2], lng: s[5], lat: s[6],
          baroAltM: s[7], onGround: s[8], velocity: s[9], track: s[10], verticalRate: s[11],
          squawk: s[14] || null, altKm: s[7] !== null ? s[7] / 1000 : 0.3,
          color: flightColor(s[14], s[8], s[11])
        }));
    },
    async ships() {
      const base = backendBase();
      if (!base) throw new Error('no poller data URL set (Sources tab)');
      let snap;
      try {
        snap = await getJson(`${base.replace(/\/+$/, '')}/ships.json`);
      } catch {
        throw new Error('no ship data yet: add the AISSTREAM_API_KEY secret');
      }
      appState.shipSnapshot = parseShipSnapshot(snap);
      return projectShips();
    },
    async quakes() {
      const data = await getJson('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson');
      return (data.features || []).map((f) => {
        const mag = f.properties.mag ?? 0;
        return {
          id: f.id, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], depthKm: f.geometry.coordinates[2],
          mag, place: f.properties.place || 'Unknown location', time: f.properties.time,
          tsunami: f.properties.tsunami === 1, url: f.properties.url, altKm: 0,
          color: hexToRgb(mag >= 5 ? '#ff4d5e' : mag >= 3 ? '#e2554a' : '#7a3a36')
        };
      });
    },
    async gdacs() {
      /* MAP now rejects requests without an event type; SEARCH returns all types (CORS: *). */
      const data = await getJson('https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ;TC;FL;VO;DR;WF&pageSize=100');
      return (data.features || [])
        .filter((f) => String(f.properties && f.properties.iscurrent) === 'true')
        .filter((f) => f.geometry && f.geometry.type === 'Point')
        .map((f) => {
          const p = f.properties || {};
          const level = p.alertlevel || 'Green';
          return {
            id: `${p.eventtype}-${p.eventid}`, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
            type: p.eventtype, name: p.name || p.eventname || 'GDACS event', alertLevel: level,
            country: p.country, from: p.fromdate, severity: p.severitydata && p.severitydata.severitytext,
            url: p.url && p.url.report, altKm: 0, color: hexToRgb(GDACS_COLOR[level] || GDACS_COLOR.Green)
          };
        });
    },
    async eonet() {
      const data = await getJson('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30');
      return (data.events || [])
        .map((ev) => {
          const g = ev.geometry && ev.geometry[ev.geometry.length - 1];
          if (!g || g.type !== 'Point') return null;
          return {
            id: ev.id, lng: g.coordinates[0], lat: g.coordinates[1], date: g.date, title: ev.title,
            category: (ev.categories && ev.categories[0] && ev.categories[0].title) || 'Event',
            url: ev.sources && ev.sources[0] && ev.sources[0].url, altKm: 0
          };
        })
        .filter(Boolean);
    },
    async live() {
      return liveStreamItems();
    },
    async satellites() {
      if (!satLibOk) throw new Error('satellite.js failed to load');
      return loadAllSatellites();
    },
    async webcams() {
      const apiKey = store.get('windyKey', '');
      if (!apiKey) throw new Error('no API key set (Sources tab)');
      const active = appState.zones.filter((z) => z.enabled);
      if (!active.length) return [];

      const results = await Promise.allSettled(active.map(async (z) => {
        const radius = Math.min(z.radiusKm, WEBCAM_MAX_RADIUS_KM);
        const params = new URLSearchParams({
          nearby: `${z.lat},${z.lng},${radius}`,
          include: 'images,location,urls,player',
          limit: String(WEBCAM_LIMIT_PER_ZONE)
        });
        const res = await fetchWithTimeout(
          `https://api.windy.com/webcams/api/v3/webcams?${params}`, 15000, { 'x-windy-api-key': apiKey }
        );
        const body = await res.json();
        return (body.webcams || []).map((w) => ({ w, zone: z.name }));
      }));

      const rejected = results.filter((r) => r.status === 'rejected');
      if (rejected.length === results.length) throw rejected[0].reason;

      const byId = new Map();
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        for (const { w, zone } of r.value) {
          const loc = w.location || {};
          if (!Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) continue;
          const id = String(w.webcamId ?? w.id);
          if (byId.has(id)) continue;
          const current = (w.images && w.images.current) || {};
          byId.set(id, {
            id, title: w.title || `Webcam ${id}`, status: w.status,
            lat: loc.latitude, lng: loc.longitude, altKm: 0,
            city: loc.city, region: loc.region, country: loc.country, zone,
            imageUrl: current.preview || current.thumbnail || null,
            lastUpdated: w.lastUpdatedOn ? Date.parse(w.lastUpdatedOn) : null,
            pageUrl: (w.urls && (w.urls.detail || (w.urls.player && w.urls.player.day))) || null,
            embed: windyPlayerEmbed(id, Boolean(w.player && w.player.live))
          });
        }
      }
      return [...byId.values()];
    },
    alerts: fetchBackendAlerts,
    cyclones: fetchCycloneItems,
    sea: fetchSeaItems,
    fires: fetchFireItems,
    news: fetchNewsItems
  };
}
