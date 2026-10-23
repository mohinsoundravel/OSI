import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const CONFIG = path.join(HERE, 'monitor.test-config.json');
const NOW = '2026-10-23T06:00:00Z';
const silent = () => {};

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'osi-poller-'));
  const fixtures = path.join(dir, 'fixtures');
  await cp(FIXTURES, fixtures, { recursive: true });
  return { dir, dataDir: path.join(dir, 'data'), fixtures };
}

const base = (env, extra = {}) => ({ dataDir: env.dataDir, fixturesDir: env.fixtures, configPath: CONFIG, now: NOW, log: silent, ...extra });

test('end to end: baseline first, then only new or escalated alerts', async () => {
  const env = await setup();
  try {
    /* Run 1: everything currently active is recorded as baseline; one startup message. */
    const r1 = await run(base(env));
    assert.equal(r1.allFailed, false);
    assert.deepEqual(r1.failures, []);
    const keys = r1.candidates.map((c) => c.key).sort();
    assert.ok(keys.includes('sachet:IN-1001_6'), 'official heat wave in Madurai, located by district name');
    assert.ok(keys.includes('sachet:IN-1002_43'), 'official dam release in Salem (Mettur Dam)');
    assert.ok(keys.includes('sachet:IN-1006_6'), 'Kerala alert located via Idukki in the headline');
    assert.ok(!keys.includes('sachet:IN-1007_8'), 'Rajasthan alert is outside every zone');
    assert.ok(!keys.includes('sachet:IN-1008_43'), 'nowcast superseded by its CAP update');
    assert.ok(keys.includes('sachet:IN-1009_43'), 'CAP update is active');
    assert.ok(keys.includes('river:vaigai-dam:high'), 'derived river rise (5x)');
    assert.ok(keys.includes('heat:madurai:high:2026-10-23'), 'derived heat wave by absolute criterion');
    assert.ok(keys.includes('gdacs:TC-1000123:Orange'), 'GDACS cyclone in India zone');
    assert.ok(!keys.includes('usgs:us7000abcd'), 'ordinary quake outside usgs.zones is not alerted');
    assert.ok(!keys.some((k) => k.includes('TEST-1003')), 'test-status CAP ignored');
    assert.ok(!keys.some((k) => k.includes('555') || k.includes('chile')), 'out-of-zone events ignored');
    assert.ok(!keys.some((k) => k.startsWith('river:mullaperiyar')), 'flat river does not alert');
    assert.ok(!keys.some((k) => k.startsWith('river:adyar')), 'small stream below floor does not alert');
    assert.equal(r1.messages.length, 1);
    assert.match(r1.messages[0], /monitor started/i);

    const byKey = (k) => r1.candidates.find((c) => c.key === k);
    const dam = byKey('sachet:IN-1002_43');
    assert.equal(dam.kind, 'dam');
    assert.equal(dam.origin, 'official');
    assert.equal(dam.severity, 'high');
    assert.deepEqual(dam.places.map((p) => p.name), ['Salem']);
    assert.ok(Math.abs(dam.lat - 11.66) < 0.01, 'anchored at the district headquarters');
    assert.equal(byKey('sachet:IN-1001_6').severity, 'high', 'heat keeps the issuer severity');
    assert.equal(byKey('sachet:IN-1006_6').severity, 'medium', 'very heavy rain is scaled to medium');
    assert.equal(byKey('sachet:IN-1009_43').severity, 'low', 'routine nowcast tagged Severe is scaled to low');
    assert.ok(!keys.includes('gdacs:FL-999:Orange'), 'GDACS events that are no longer current are ignored');
    const riverAlert = r1.candidates.find((c) => c.key === 'river:vaigai-dam:high');
    assert.equal(riverAlert.origin, 'derived');

    const state = JSON.parse(await readFile(path.join(env.dataDir, 'state.json'), 'utf8'));
    assert.ok(state.sachetSeen['https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=1004'], 'hostile CAP is marked seen, never refetched');
    assert.equal(state.sachetActive['IN-1002_43'].locatedBy, 'district-names');
    assert.ok(state.sachetActive['IN-1002_43'].geocodes.some((g) => g.value === '582'), 'LGD codes retained');
    const latest = JSON.parse(await readFile(path.join(env.dataDir, 'latest.json'), 'utf8'));
    assert.equal(latest.health.sachet.ok, true);
    assert.ok(latest.health.sachet.warnings.some((w) => /DOCTYPE/.test(w)), 'hostile CAP reported as warning');
    assert.ok(latest.health.sachet.warnings.some((w) => /allowlist/.test(w)), 'off-allowlist CAP link blocked');
    const events = JSON.parse(await readFile(path.join(env.dataDir, 'events.json'), 'utf8'));
    assert.ok(events.every((e) => e.baseline === true));

    /* Run 2: nothing changed, nothing sent. */
    const r2 = await run(base(env, { now: '2026-10-23T06:30:00Z' }));
    assert.equal(r2.fresh.length, 0);
    assert.equal(r2.messages.length, 0);

    /* Run 3: the cyclone escalates to Red -> exactly one new critical alert. */
    const gdacsFile = path.join(env.fixtures, 'www.gdacs.org_gdacsapi_api_events_geteventlist_SEARCH');
    const gdacs = JSON.parse(await readFile(gdacsFile, 'utf8'));
    gdacs.features[0].properties.alertlevel = 'Red';
    await writeFile(gdacsFile, JSON.stringify(gdacs));
    const r3 = await run(base(env, { now: '2026-10-23T07:00:00Z' }));
    assert.deepEqual(r3.fresh.map((c) => c.key), ['gdacs:TC-1000123:Red']);
    assert.equal(r3.messages.length, 1);
    assert.match(r3.messages[0], /^\[CRITICAL\] GDACS Red/);
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});

test('a source failing three runs in a row sends one degraded notice, then one recovery notice', async () => {
  const env = await setup();
  try {
    await run(base(env));
    const usgsFile = path.join(env.fixtures, 'earthquake.usgs.gov_earthquakes_feed_v1.0_summary_2.5_day.geojson');
    const saved = await readFile(usgsFile, 'utf8');
    await rm(usgsFile);

    const notices = [];
    for (let i = 1; i <= 4; i++) {
      const r = await run(base(env, { now: `2026-10-23T${String(6 + i).padStart(2, '0')}:00:00Z` }));
      assert.deepEqual(r.failures, ['quakes']);
      notices.push(...r.messages.filter((m) => /degraded/i.test(m)));
    }
    assert.equal(notices.length, 1, 'degraded notice sent once');

    await writeFile(usgsFile, saved);
    const recovered = await run(base(env, { now: '2026-10-23T11:30:00Z' }));
    assert.ok(recovered.messages.some((m) => /recovered: quakes/i.test(m)));
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});

test('all sources failing marks the run failed (so GitHub emails the owner)', async () => {
  const env = await setup();
  try {
    const empty = path.join(env.dir, 'empty');
    await cp(FIXTURES, empty, { recursive: true, filter: (src) => src === FIXTURES });
    const r = await run(base(env, { fixturesDir: empty }));
    assert.equal(r.allFailed, true);
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});

test('invalid config is rejected before any network access', async () => {
  const env = await setup();
  try {
    await assert.rejects(run(base(env, { configJson: JSON.stringify({ zones: [] }) })), /zones must be a non-empty array/);
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});

test('a state schema change re-parses SACHET and re-baselines without notifying', async () => {
  const env = await setup();
  try {
    await run(base(env));
    const statePath = path.join(env.dataDir, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.schema = 1;
    for (const a of Object.values(state.sachetActive)) a.places = [];
    await writeFile(statePath, JSON.stringify(state));

    const r = await run(base(env, { now: '2026-10-23T06:30:00Z' }));
    assert.equal(r.messages.length, 1);
    assert.match(r.messages[0], /monitor reconfigured/i, 'treated as a fresh baseline, not a burst of alerts');
    const after = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(after.schema, 4);
    assert.deepEqual(after.sachetActive['IN-1002_43'].places.map((p) => p.name), ['Salem'], 'alerts re-parsed with locations');
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});

test('heartbeat outcome is published without exposing the URL', async () => {
  const env = await setup();
  try {
    const calls = [];
    const fakeFetch = async (url) => { calls.push(String(url)); return { status: 200 }; };
    const secretUrl = 'https://hc-ping.com/00000000-0000-0000-0000-000000000000';
    const r = await run(base(env, { healthcheckUrl: secretUrl, heartbeatFetch: fakeFetch }));
    assert.deepEqual(calls, [secretUrl]);
    assert.equal(r.latest.heartbeat.ok, true);
    assert.equal(r.latest.heartbeat.signal, 'success');
    const published = await readFile(path.join(env.dataDir, 'latest.json'), 'utf8');
    assert.ok(!published.includes('00000000-0000'), 'ping URL never written to published data');

    const none = await run(base(env, { now: '2026-10-23T06:30:00Z' }));
    assert.deepEqual([none.latest.heartbeat.configured, none.latest.heartbeat.ok], [false, false]);
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});
