#!/usr/bin/env node
/**
 * OSI monitor poller. Runs once per invocation (GitHub Actions schedule):
 *   fetch sources -> normalize -> evaluate rules -> de-duplicate -> notify -> write outputs.
 *
 * Usage: node poller/index.mjs [--data-dir data] [--config config/monitor.json]
 *                              [--fixtures dir] [--dry-run] [--now ISO]
 * Env:   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, HEALTHCHECK_URL, MONITOR_CONFIG_JSON (optional)
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { createHttpClient } from './lib/http.mjs';
import { fetchSachet } from './sources/sachet.mjs';
import { fetchRiverDischarge, fetchTemperatures, assessHeat } from './sources/openmeteo.mjs';
import { fetchGdacs, fetchUsgs } from './sources/hazards.mjs';
import { fetchFlights, expandFlights, FLIGHT_FIELDS } from './sources/flights.mjs';
import { fetchTle } from './sources/tle.mjs';
import { fetchReservoirs, reservoirLayer, addToHistory, backfillHistory } from './sources/reservoirs.mjs';
import { listenShips, mergeShips, SHIP_FIELDS } from './sources/ships.mjs';
import { evaluate, SEVERITY_RANK } from './rules.mjs';
import { buildMessages, createNotifier, heartbeat } from './notify.mjs';

const DAY_MS = 24 * 3600 * 1000;
const BASE_HOSTS = [
  'sachet.ndma.gov.in', 'flood-api.open-meteo.com', 'api.open-meteo.com',
  'www.gdacs.org', 'earthquake.usgs.gov', 'opensky-network.org', 'celestrak.org', 'www.amsat.org',
  'tnagriculture.in'
];
const DEGRADED_AFTER_FAILURES = 3;
/* Auxiliary sources feed the dashboard but are not safety-critical: their failures
   never trigger degraded notices or count toward "every source failed". */
const AUXILIARY = new Set(['flights', 'satellites', 'ships']);
const MAX_EVENTS = 500;
const MAX_RING_VERTICES = 160;
/* Bump when the shape of persisted alerts changes. A mismatch re-parses SACHET and
   re-baselines, so a migration never replays old alerts as new notifications. */
const STATE_SCHEMA = 4;

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`${file}: ${err.message}`);
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 1)}\n`);
  await rename(tmp, file);
}

function validateConfig(cfg) {
  const errors = [];
  if (!Array.isArray(cfg.zones) || !cfg.zones.length) errors.push('zones must be a non-empty array');
  for (const z of cfg.zones || []) {
    if (!z.id || !Number.isFinite(z.lat) || !Number.isFinite(z.lng) || !(z.radiusKm > 0)) errors.push(`zone ${z.id || '?'} is invalid`);
  }
  for (const p of [...(cfg.flood?.points || []), ...(cfg.heat?.points || [])]) {
    if (!p.id || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) errors.push(`point ${p.id || '?'} is invalid`);
  }
  if (errors.length) throw new Error(`invalid config: ${errors.join('; ')}`);
  return cfg;
}

/** Thin out large CAP polygons for the dashboard file; the full ring stays in state. */
function simplifyRing(ring) {
  if (ring.length <= MAX_RING_VERTICES) return ring;
  const step = Math.ceil(ring.length / MAX_RING_VERTICES);
  const out = ring.filter((_, i) => i % step === 0);
  out.push(ring[ring.length - 1]);
  return out;
}

function istDate(ms) {
  return new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

export async function run(options = {}) {
  const log = options.log || ((m) => console.log(m));
  const now = options.now ? Date.parse(options.now) : Date.now();
  const dataDir = path.resolve(options.dataDir || 'data');
  await mkdir(dataDir, { recursive: true });

  let rawConfig;
  if (options.configJson) {
    rawConfig = JSON.parse(options.configJson);
  } else {
    const configPath = path.resolve(options.configPath || 'config/monitor.json');
    rawConfig = await readJson(configPath, null);
    if (!rawConfig) throw new Error(`config not found: ${configPath}`);
  }
  const config = validateConfig(rawConfig);

  const state = await readJson(path.join(dataDir, 'state.json'), {});
  const prevLatest = await readJson(path.join(dataDir, 'latest.json'), {});
  const events = await readJson(path.join(dataDir, 'events.json'), []);
  const normals = await readJson(path.join(dataDir, 'heat-normals.json'), null) || config.heat?.normals || null;

  const reconfigured = state.schema !== undefined && state.schema !== STATE_SCHEMA;
  if (state.schema !== STATE_SCHEMA) {
    if (state.schema !== undefined || state.initialized) log(`state schema ${state.schema ?? 1} -> ${STATE_SCHEMA}: re-parsing SACHET and re-baselining`);
    delete state.sachetActive;
    delete state.sachetSeen;
    state.httpCache = {};
    state.initialized = false;
    state.schema = STATE_SCHEMA;
  }
  state.httpCache ||= {};
  state.health ||= {};
  state.notified ||= {};

  const http = createHttpClient({
    allowedHosts: [...BASE_HOSTS, ...(config.extraAllowedHosts || [])],
    userAgent: config.userAgent || 'OSI-Monitor/1.0 (+https://github.com/)',
    cache: state.httpCache,
    fixturesDir: options.fixturesDir || null
  });

  const today = istDate(now);
  const tasks = {
    sachet: () => fetchSachet({ http, feeds: config.sachet?.feeds || [], prev: state.sachetActive || {}, seenLinks: state.sachetSeen || {}, now, log }),
    rivers: () => fetchRiverDischarge({ http, points: config.flood?.points || [], today }),
    heat: () => fetchTemperatures({ http, points: config.heat?.points || [] }),
    gdacs: () => fetchGdacs({ http }),
    quakes: () => fetchUsgs({ http }),
    ...(config.reservoirs?.enabled === false ? {} : {
      reservoirs: () => fetchReservoirs({
        http,
        lastFetchedAt: state.reservoirsFetchedAt ? Date.parse(state.reservoirsFetchedAt) : 0,
        known: [state.reservoirs?.current, state.reservoirs?.previous],
        now
      })
    }),
    ...(config.flights?.enabled === false ? {} : {
      flights: () => fetchFlights({ http, lastFetchedAt: state.flightsFetchedAt ? Date.parse(state.flightsFetchedAt) : 0, now })
    }),
    /* Ships need an AISStream key (GitHub secret); without one the source is simply absent. */
    ...(config.ships?.enabled === false || !options.aisKey ? {} : {
      ships: () => listenShips({ apiKey: options.aisKey, listenMs: options.shipsListenMs ?? config.ships?.listenMs ?? 45000, connect: options.shipsConnect, userAgent: config.userAgent })
    }),
    ...(config.satellites?.enabled === false ? {} : {
      satellites: () => fetchTle({ http, lastFetchedAt: state.tleFetchedAt ? Date.parse(state.tleFetchedAt) : 0, now, log })
    })
  };

  const names = Object.keys(tasks);
  const started = Date.now();
  const settled = await Promise.allSettled(names.map((n) => tasks[n]()));

  const data = {};
  const failures = [];
  settled.forEach((r, i) => {
    const name = names[i];
    const h = (state.health[name] ||= { failures: 0 });
    /* SACHET resolves even when every feed failed (so active alerts carry over); count that as a failure. */
    const sachetDown = name === 'sachet' && r.status === 'fulfilled' && r.value.feedsOk === 0 && (config.sachet?.feeds || []).length > 0;
    if (sachetDown) {
      h.failures += 1;
      h.error = String(r.value.errors[0] || 'all feeds failed').slice(0, 300);
      h.lastError = new Date(now).toISOString();
      failures.push(name);
      data[name] = r.value;
      log(`source ${name} failed: ${h.error}`);
    } else if (r.status === 'fulfilled') {
      h.failures = 0;
      h.lastOk = new Date(now).toISOString();
      h.error = null;
      data[name] = r.value;
    } else {
      h.failures += 1;
      h.error = String(r.reason?.message || r.reason).slice(0, 300);
      h.lastError = new Date(now).toISOString();
      failures.push(name);
      log(`source ${name} failed: ${h.error}`);
    }
  });

  /* SACHET can partially fail (one feed or one CAP document) without failing outright. */
  if (data.sachet) {
    state.sachetActive = data.sachet.active;
    state.sachetSeen = data.sachet.seenLinks;
    if (data.sachet.errors.length) state.health.sachet.warnings = data.sachet.errors.slice(0, 10);
    else delete state.health.sachet.warnings;
  }

  /* Conditional requests return null when a feed is unchanged: reuse the previous snapshot. */
  const layerData = {
    sachet: state.sachetActive || {},
    rivers: data.rivers ?? prevLatest.layers?.rivers ?? [],
    heat: data.heat ?? prevLatest.layers?.heatRaw ?? [],
    gdacs: data.gdacs ?? state.gdacsSnapshot ?? [],
    quakes: data.quakes ?? state.quakesSnapshot ?? []
  };
  /* Reservoirs: daily figures, fetched at most hourly; the last snapshot is reused in between. */
  if (data.reservoirs) {
    state.reservoirs = data.reservoirs;
    state.reservoirsFetchedAt = new Date(now).toISOString();
    /* Daily history for trend charts: today's and yesterday's pages, plus a few missing past days per run. */
    const histFile = path.join(dataDir, 'reservoir-history.json');
    let history = await readJson(histFile, null).catch(() => null);
    history = addToHistory(history, data.reservoirs.previous);
    history = addToHistory(history, data.reservoirs.current);
    try {
      const filled = await backfillHistory({ http, history, latest: data.reservoirs.current.date, unavailable: state.reservoirHistoryGaps || [] });
      history = filled.history;
      state.reservoirHistoryGaps = filled.unavailable;
    } catch (err) {
      log(`reservoir history backfill skipped: ${err.message}`);
    }
    history.updatedAt = new Date(now).toISOString();
    history.source = 'TN Agriculture Dept (WRD daily reservoir data)';
    await writeJsonAtomic(histFile, history);
  }
  layerData.reservoirs = reservoirLayer(state.reservoirs);
  if (data.gdacs) state.gdacsSnapshot = data.gdacs.filter((e) => e.alertLevel !== 'Green');
  if (data.quakes) state.quakesSnapshot = data.quakes.filter((q) => q.mag >= 4);

  /* Flights: publish a compact snapshot for the dashboard; keep emergency squawks for rules. */
  if (data.flights) {
    state.flightsFetchedAt = new Date(now).toISOString();
    await writeJsonAtomic(path.join(dataDir, 'flights.json'), {
      schema: 1, fetchedAt: state.flightsFetchedAt, time: data.flights.time,
      fields: FLIGHT_FIELDS, states: data.flights.states
    });
    state.squawkSnapshot = expandFlights(data.flights).filter((f) => f.squawk && ['7500', '7600', '7700'].includes(f.squawk));
  }
  layerData.squawks = state.squawkSnapshot || [];

  /* Ships: merge this run's AIS window with earlier ones and publish a compact snapshot. */
  if (data.ships) {
    const rows = mergeShips(state, data.ships, now);
    await writeJsonAtomic(path.join(dataDir, 'ships.json'), {
      schema: 1, fetchedAt: new Date(now).toISOString(), source: 'AISStream.io', heardThisRun: data.ships.positions.size,
      messages: data.ships.messages, fields: SHIP_FIELDS, ships: rows
    });
    log(`ships: heard ${data.ships.positions.size} positions in ${data.ships.messages} messages; publishing ${rows.length}`);
  }

  /* Satellites: republish CelesTrak TLEs for the dashboard (propagated in the browser). */
  if (data.satellites) {
    state.tleFetchedAt = new Date(now).toISOString();
    await writeJsonAtomic(path.join(dataDir, 'tle.json'), { schema: 1, fetchedAt: state.tleFetchedAt, source: 'CelesTrak', groups: data.satellites });
  }

  const candidates = evaluate({ config, data: layerData, normals });

  /* De-duplicate: each key notifies once per window; escalations carry a new key. */
  const dedupeMs = (config.notify?.dedupeDays ?? 3) * DAY_MS;
  for (const [k, ts] of Object.entries(state.notified)) if (now - ts > dedupeMs) delete state.notified[k];
  const fresh = candidates.filter((c) => !Object.hasOwn(state.notified, c.key));
  const firstRun = !state.initialized;
  for (const c of fresh) state.notified[c.key] = now;

  const detectedAt = new Date(now).toISOString();
  for (const c of fresh) {
    events.unshift({
      id: c.key, detectedAt, baseline: firstRun,
      ...Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'polygons' && k !== 'circles' && k !== 'key'))
    });
  }
  const keptEvents = events.filter((e) => now - Date.parse(e.detectedAt) < 7 * DAY_MS).slice(0, MAX_EVENTS);

  /* Notifications. */
  const notifier = createNotifier({ token: options.telegramToken, chatId: options.telegramChatId, dryRun: options.dryRun, log });
  const messages = [];
  if (firstRun) {
    const top = [...candidates].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]).slice(0, 10);
    messages.push([
      reconfigured ? 'OSI monitor reconfigured (coverage or rules changed).' : 'OSI monitor started.',
      `${candidates.length} alert(s) currently active in your zones were recorded as baseline; from now on only new or escalated alerts are sent.`,
      ...top.map((c) => `- [${c.severity}] ${c.title} (${c.origin})`)
    ].join('\n'));
    state.initialized = true;
  } else {
    messages.push(...buildMessages(fresh, config.notify));
  }

  for (const name of names) {
    const h = state.health[name];
    if (!h || AUXILIARY.has(name)) continue;
    if (h.failures >= DEGRADED_AFTER_FAILURES && !h.degradedNotified) {
      messages.push(`Monitor degraded: ${name} has failed ${h.failures} runs in a row.\nLast error: ${h.error}\nAlerts from this source are paused until it recovers.`);
      h.degradedNotified = true;
    } else if (h.failures === 0 && h.degradedNotified) {
      messages.push(`Monitor recovered: ${name} is responding again.`);
      h.degradedNotified = false;
    }
  }

  let sent = 0;
  for (const m of messages) if (await notifier.send(m)) sent++;

  /* Outputs for the dashboard. */
  const failedSet = new Set(failures);
  const heatLayer = (data.heat ?? layerData.heat).map((p) => {
    const { days, alert } = assessHeat(p, normals?.[p.id]);
    return { id: p.id, name: p.name, lat: p.lat, lng: p.lng, region: p.region, days, alert };
  });
  const latest = {
    schema: 1,
    generatedAt: detectedAt,
    durationMs: Date.now() - started,
    health: Object.fromEntries(names.map((n) => [n, {
      ok: !failedSet.has(n),
      lastOk: state.health[n]?.lastOk || null,
      failures: state.health[n]?.failures || 0,
      error: state.health[n]?.error || null,
      warnings: state.health[n]?.warnings || undefined
    }])),
    layers: {
      sachet: Object.values(layerData.sachet).map((a) => ({
        id: a.identifier, event: a.event, headline: a.headline, kinds: a.kinds, severity: a.severity,
        urgency: a.urgency, certainty: a.certainty, senderName: a.senderName, areaDesc: a.areaDesc,
        effective: a.effective, expires: a.expires, link: a.link, lat: a.lat, lng: a.lng,
        locatedBy: a.locatedBy || 'none', places: (a.places || []).slice(0, 40),
        polygons: a.polygons.slice(0, 10).map(simplifyRing)
      })),
      rivers: layerData.rivers,
      heat: heatLayer,
      heatRaw: layerData.heat,
      reservoirs: layerData.reservoirs
    },
    active: candidates.map((c) => ({ ...c, polygons: undefined, circles: undefined }))
  };

  /* Ping before writing outputs so the heartbeat result is published with them. */
  const critical = names.filter((n) => !AUXILIARY.has(n));
  const allFailed = critical.every((n) => failedSet.has(n));
  const summary = `sources ok ${names.length - failedSet.size}/${names.length}; ${candidates.length} active, ${fresh.length} new; ${sent}/${messages.length} messages sent`;
  log(summary);
  const beat = await heartbeat(options.healthcheckUrl, { failed: allFailed, body: summary, log, fetchImpl: options.heartbeatFetch });
  latest.heartbeat = beat;
  latest.notifications = { telegramConfigured: notifier.enabled, attempted: messages.length, sent };

  await writeJsonAtomic(path.join(dataDir, 'latest.json'), latest);
  await writeJsonAtomic(path.join(dataDir, 'events.json'), keptEvents);
  await writeJsonAtomic(path.join(dataDir, 'state.json'), state);
  return { allFailed, failures: [...failedSet], candidates, fresh, messages, latest };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string', default: 'data' },
      config: { type: 'string', default: 'config/monitor.json' },
      fixtures: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      now: { type: 'string' }
    }
  });
  run({
    dataDir: values['data-dir'],
    configPath: values.config,
    configJson: process.env.MONITOR_CONFIG_JSON || null,
    fixturesDir: values.fixtures || null,
    dryRun: values['dry-run'],
    now: values.now,
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    healthcheckUrl: process.env.HEALTHCHECK_URL,
    aisKey: process.env.AISSTREAM_API_KEY || null
  }).then((r) => {
    process.exitCode = r.allFailed ? 1 : 0;
  }).catch(async (err) => {
    console.error(`poller crashed: ${err.stack || err.message}`);
    await heartbeat(process.env.HEALTHCHECK_URL, { failed: true, body: String(err.message) });
    process.exitCode = 1;
  });
}
