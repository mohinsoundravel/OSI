const EARTH_KM = 6371;
const DEG = Math.PI / 180;

export function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const isLat = (v) => Number.isFinite(v) && v >= -90 && v <= 90;
export const isLng = (v) => Number.isFinite(v) && v >= -180 && v <= 180;

/**
 * Parses a CAP <polygon>: space-separated "lat,lon" pairs (CAP uses lat,lon order;
 * GeoJSON uses lon,lat). Returns [[lng, lat], ...] or null if invalid.
 */
export function parseCapPolygon(text, maxVertices = 2000) {
  const pairs = String(text).trim().split(/\s+/).slice(0, maxVertices);
  const ring = [];
  for (const pair of pairs) {
    const [latStr, lngStr] = pair.split(',');
    const lat = Number(latStr);
    const lng = Number(lngStr);
    if (!isLat(lat) || !isLng(lng)) return null;
    ring.push([lng, lat]);
  }
  return ring.length >= 4 ? ring : null;
}

/** Parses a CAP <circle>: "lat,lon radiusKm". */
export function parseCapCircle(text) {
  const [center, radius] = String(text).trim().split(/\s+/);
  if (!center) return null;
  const [lat, lng] = center.split(',').map(Number);
  const radiusKm = Number(radius);
  if (!isLat(lat) || !isLng(lng) || !Number.isFinite(radiusKm) || radiusKm < 0) return null;
  return { lat, lng, radiusKm };
}

/** Area-weighted centroid of a ring of [lng, lat]; falls back to the vertex mean for degenerate rings. */
export function ringCentroid(ring) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  if (Math.abs(area) < 1e-12) {
    const n = ring.length;
    return { lng: ring.reduce((s, p) => s + p[0], 0) / n, lat: ring.reduce((s, p) => s + p[1], 0) / n };
  }
  area /= 2;
  return { lng: cx / (6 * area), lat: cy / (6 * area) };
}

/** Ray-casting point-in-polygon on [lng, lat] rings (planar; adequate at district scale). */
export function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = (yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** True if any polygon vertex or the centroid falls inside the zone, or the zone centre lies inside the polygon. */
export function ringIntersectsZone(ring, zone) {
  if (pointInRing(zone.lat, zone.lng, ring)) return true;
  const c = ringCentroid(ring);
  if (haversineKm(zone.lat, zone.lng, c.lat, c.lng) <= zone.radiusKm) return true;
  return ring.some(([lng, lat]) => haversineKm(zone.lat, zone.lng, lat, lng) <= zone.radiusKm);
}

export function zonesForPoint(lat, lng, zones) {
  return zones.filter((z) => z.enabled !== false && haversineKm(z.lat, z.lng, lat, lng) <= z.radiusKm);
}

export function zonesForArea(area, zones) {
  const active = zones.filter((z) => z.enabled !== false);
  return active.filter((z) =>
    area.polygons.some((ring) => ringIntersectsZone(ring, z)) ||
    area.circles.some((c) => haversineKm(z.lat, z.lng, c.lat, c.lng) <= z.radiusKm + c.radiusKm));
}
