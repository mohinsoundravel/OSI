/** Global hazard feeds that are also useful while the dashboard is closed. */

/* The MAP endpoint now rejects requests without an event type; SEARCH accepts several. */
const GDACS_URL = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ;TC;FL;VO;DR;WF&alertlevel=Orange;Red&pageSize=100';
const USGS_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';

const GDACS_TYPES = { EQ: 'Earthquake', TC: 'Tropical cyclone', FL: 'Flood', VO: 'Volcano', DR: 'Drought', WF: 'Wildfire' };

/* GDACS SEARCH is slow at times (about 120 KB, observed 20 s+ timeouts from GitHub runners).
   Allow 45 s and retry once on a timeout before counting the source as failed. */
const GDACS_TIMEOUT_MS = 45000;

async function getGdacs(http) {
  try {
    return await http.getJson(GDACS_URL, { conditional: true, timeoutMs: GDACS_TIMEOUT_MS });
  } catch (err) {
    if (!/timeout/.test(err.message)) throw err;
    return http.getJson(GDACS_URL, { conditional: true, timeoutMs: GDACS_TIMEOUT_MS });
  }
}

export async function fetchGdacs({ http }) {
  const { json, notModified } = await getGdacs(http);
  if (notModified) return null;
  return (json.features || [])
    .filter((f) => String(f.properties?.iscurrent) === 'true')
    .filter((f) => f.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates))
    .map((f) => {
      const p = f.properties || {};
      return {
        id: `${p.eventtype}-${p.eventid}`,
        type: GDACS_TYPES[p.eventtype] || String(p.eventtype || 'Event'),
        name: String(p.name || p.eventname || 'GDACS event').slice(0, 200),
        alertLevel: ['Green', 'Orange', 'Red'].includes(p.alertlevel) ? p.alertlevel : 'Green',
        country: String(p.country || '').slice(0, 120),
        lng: Number(f.geometry.coordinates[0]),
        lat: Number(f.geometry.coordinates[1]),
        url: typeof p.url?.report === 'string' ? p.url.report : null
      };
    })
    .filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lng));
}

export async function fetchUsgs({ http }) {
  const { json, notModified } = await http.getJson(USGS_URL, { conditional: true });
  if (notModified) return null;
  return (json.features || []).map((f) => ({
    id: String(f.id),
    mag: Number(f.properties?.mag),
    place: String(f.properties?.place || 'Unknown location').slice(0, 200),
    time: f.properties?.time,
    tsunami: f.properties?.tsunami === 1,
    url: typeof f.properties?.url === 'string' ? f.properties.url : null,
    lng: Number(f.geometry?.coordinates?.[0]),
    lat: Number(f.geometry?.coordinates?.[1]),
    depthKm: Number(f.geometry?.coordinates?.[2])
  })).filter((q) => Number.isFinite(q.lat) && Number.isFinite(q.lng) && Number.isFinite(q.mag));
}
