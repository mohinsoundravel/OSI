#!/usr/bin/env node
/**
 * Snaps river monitoring points onto the GloFAS grid cell that actually carries
 * the river. GloFAS (via Open-Meteo) is a ~5 km grid; a coordinate a few km off
 * the channel can report near-zero discharge (seen at Mettur). For each
 * candidate, this scans a 7x7 grid of nearby cells (0.05 deg steps, one batched
 * request) and reports the cell with the highest mean discharge over the past
 * ~3 months. Read-only: prints a report and a ready-to-paste config block.
 */
import { createHttpClient } from './lib/http.mjs';

const CANDIDATES = [
  { id: 'cauvery-mettur', name: 'Cauvery below Mettur Dam', lat: 11.79, lng: 77.80 },
  { id: 'cauvery-trichy', name: 'Cauvery at Tiruchirappalli', lat: 10.86, lng: 78.60 },
  { id: 'cauvery-grand-anicut', name: 'Cauvery at Grand Anicut', lat: 10.83, lng: 78.82 },
  { id: 'bhavani', name: 'Bhavani at Bhavanisagar', lat: 11.47, lng: 77.13 },
  { id: 'amaravathi-karur', name: 'Amaravathi at Karur', lat: 10.96, lng: 78.08 },
  { id: 'vaigai-dam', name: 'Vaigai below Vaigai Dam', lat: 10.05, lng: 77.58 },
  { id: 'vaigai-madurai', name: 'Vaigai at Madurai', lat: 9.93, lng: 78.12 },
  { id: 'thamirabarani', name: 'Thamirabarani at Tirunelveli', lat: 8.73, lng: 77.70 },
  { id: 'periyar-mullaperiyar', name: 'Periyar at Mullaperiyar', lat: 9.53, lng: 77.14 },
  { id: 'palar-vellore', name: 'Palar at Vellore', lat: 12.92, lng: 79.13 },
  { id: 'pennaiyar-krishnagiri', name: 'Thenpennai at Krishnagiri', lat: 12.47, lng: 78.18 },
  { id: 'pennaiyar-cuddalore', name: 'Thenpennai near Cuddalore', lat: 11.76, lng: 79.70 },
  { id: 'adyar-chennai', name: 'Adyar, Chennai', lat: 13.01, lng: 80.24 },
  { id: 'cooum-chennai', name: 'Cooum, Chennai', lat: 13.07, lng: 80.27 },
  { id: 'kosasthalaiyar', name: 'Kosasthalaiyar near Ennore', lat: 13.23, lng: 80.30 }
];

const STEP = 0.05;
const RADIUS_STEPS = 3;
const http = createHttpClient({ allowedHosts: ['flood-api.open-meteo.com'], userAgent: 'OSI-Monitor/1.0 (river calibration)', timeoutMs: 60000 });
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

const chosen = [];
console.log('id | original mean m3/s | snapped lat,lng | snapped mean | snapped max | offset km');
for (const c of CANDIDATES) {
  const cells = [];
  for (let i = -RADIUS_STEPS; i <= RADIUS_STEPS; i++) {
    for (let j = -RADIUS_STEPS; j <= RADIUS_STEPS; j++) cells.push({ lat: round(c.lat + i * STEP), lng: round(c.lng + j * STEP), center: i === 0 && j === 0 });
  }
  const q = new URLSearchParams({
    latitude: cells.map((x) => x.lat).join(','), longitude: cells.map((x) => x.lng).join(','),
    daily: 'river_discharge', past_days: '92', forecast_days: '1'
  });
  try {
    const { json } = await http.getJson(`https://flood-api.open-meteo.com/v1/flood?${q}`);
    const results = Array.isArray(json) ? json : [json];
    const scored = cells.map((cell, k) => {
      const vals = (results[k]?.daily?.river_discharge || []).filter(Number.isFinite);
      return { ...cell, mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0, max: vals.length ? Math.max(...vals) : 0 };
    });
    const center = scored.find((s) => s.center);
    const best = scored.reduce((a, b) => (b.mean > a.mean ? b : a));
    const offsetKm = Math.hypot((best.lat - c.lat) * 111, (best.lng - c.lng) * 111 * Math.cos((c.lat * Math.PI) / 180));
    console.log(`${c.id} | ${round(center.mean, 1)} | ${best.lat},${best.lng} | ${round(best.mean, 1)} | ${round(best.max, 1)} | ${round(offsetKm, 1)}`);
    chosen.push({ ...c, lat: best.lat, lng: best.lng, mean: round(best.mean, 1) });
  } catch (err) {
    console.log(`${c.id} | ERROR ${err.message}`);
  }
}

console.log('\n--- suggested config (minDischarge = 50% of recent mean, at least 10 m3/s) ---');
console.log(JSON.stringify(chosen.map((c) => ({
  id: c.id, name: c.name, lat: c.lat, lng: c.lng, minDischarge: Math.max(10, Math.round(c.mean * 0.5)), recentMean: c.mean
})), null, 1));
