import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertSafeXml, decodeEntities, firstText, textOf, clampText, UnsafeXmlError } from '../lib/xml.mjs';
import { parseCapPolygon, pointInRing, zonesForArea, zonesForPoint, ringCentroid } from '../lib/geo.mjs';
import { createHttpClient } from '../lib/http.mjs';
import { parseCap, parseRss, classifyKinds } from '../sources/sachet.mjs';
import { classifyHeatDay, assessHeat, assessRiver } from '../sources/openmeteo.mjs';
import { buildMessages, formatAlert } from '../notify.mjs';
import { evaluate, sachetSeverity } from '../rules.mjs';
import { loadGazetteer, matchPlaces } from '../lib/places.mjs';

/* ---------- XML safety ---------- */

test('rejects documents that declare a DOCTYPE or ENTITY', () => {
  assert.throws(() => assertSafeXml('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>'), UnsafeXmlError);
  assert.throws(() => assertSafeXml('<x><!ENTITY a SYSTEM "file:///etc/passwd"></x>'), UnsafeXmlError);
  assert.doesNotThrow(() => assertSafeXml('<?xml version="1.0"?><x/>'));
});

test('decodes only predefined and numeric entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#176; &#x2603;'), 'a & b <c> ° ☃');
  assert.equal(decodeEntities('&custom;'), '&custom;');
  assert.equal(decodeEntities('&#0;&#xFFFFFFF;'), '');
});

test('keeps CDATA content literal, including markup characters', () => {
  assert.equal(textOf('<![CDATA[Dam & river <b>rising</b>]]>'), 'Dam & river <b>rising</b>');
});

test('matches elements regardless of namespace prefix', () => {
  assert.equal(firstText('<cap:alert><cap:event>Flood</cap:event></cap:alert>', 'event'), 'Flood');
});

test('clampText strips control characters and truncates', () => {
  assert.equal(clampText('ab\u0000c', 10), 'abc');
  assert.equal(clampText('abcdefghij', 5).length, 5);
});

/* ---------- Geometry ---------- */

test('CAP polygons are lat,lon and become [lng, lat] rings', () => {
  const ring = parseCapPolygon('9.8,77.9 10.1,77.9 10.1,78.3 9.8,77.9');
  assert.deepEqual(ring[0], [77.9, 9.8]);
  assert.equal(parseCapPolygon('95,10 1,1 2,2 95,10'), null, 'latitude out of range is rejected');
  assert.equal(parseCapPolygon('1,1 2,2'), null, 'too few vertices');
});

test('point in polygon and zone intersection', () => {
  const ring = parseCapPolygon('9.8,77.9 10.2,77.9 10.2,78.3 9.8,78.3 9.8,77.9');
  assert.ok(pointInRing(10.0, 78.1, ring));
  assert.ok(!pointInRing(11.0, 78.1, ring));
  const c = ringCentroid(ring);
  assert.ok(Math.abs(c.lat - 10.0) < 0.01 && Math.abs(c.lng - 78.1) < 0.01);

  const zones = [{ id: 'near', lat: 10.0, lng: 77.5, radiusKm: 50 }, { id: 'delhi', lat: 28.6, lng: 77.2, radiusKm: 100 }];
  const hits = zonesForArea({ polygons: [ring], circles: [] }, zones);
  assert.deepEqual(hits.map((z) => z.id), ['near']);
  assert.deepEqual(zonesForPoint(28.7, 77.1, zones).map((z) => z.id), ['delhi']);
  assert.equal(zonesForPoint(28.7, 77.1, [{ ...zones[1], enabled: false }]).length, 0);
});

/* ---------- HTTP client ---------- */

test('http client blocks non-https and non-allowlisted hosts', async () => {
  const http = createHttpClient({ allowedHosts: ['ok.example'], userAgent: 't', fetchImpl: async () => { throw new Error('should not fetch'); } });
  await assert.rejects(http.getText('http://ok.example/x'), /non-https/);
  await assert.rejects(http.getText('https://evil.example/x'), /allowlist/);
  await assert.rejects(http.getText('not a url'), /invalid URL/);
});

test('http client rejects redirects that leave the allowlist', async () => {
  const redirected = async () => ({
    ok: true, status: 200, url: 'https://evil.example/landing', headers: new Headers(), text: async () => 'x'
  });
  const http = createHttpClient({ allowedHosts: ['ok.example'], userAgent: 't', fetchImpl: redirected });
  await assert.rejects(http.getText('https://ok.example/feed'), /allowlist/);
});

test('conditional requests reuse cache on 304', async () => {
  const cache = {};
  let calls = 0;
  const fetchImpl = async (url, { headers }) => {
    calls++;
    if (headers['If-None-Match'] === '"v1"') return new Response(null, { status: 304 });
    return new Response('payload', { status: 200, headers: { etag: '"v1"' } });
  };
  const http = createHttpClient({ allowedHosts: ['ok.example'], userAgent: 't', cache, fetchImpl });
  const first = await http.getText('https://ok.example/feed', { conditional: true });
  const second = await http.getText('https://ok.example/feed', { conditional: true });
  assert.equal(first.text, 'payload');
  assert.equal(second.notModified, true);
  assert.equal(second.hash, first.hash);
  assert.equal(calls, 2);
});

/* ---------- SACHET / CAP ---------- */

const CAP = `<?xml version="1.0"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>X-1</identifier><sender>a@b</sender><sent>2026-10-23T09:00:00+05:30</sent>
  <status>Actual</status><msgType>Alert</msgType><scope>Public</scope>
  <info><language>hi-IN</language><event>बाढ़</event></info>
  <info><language>en-IN</language><event>Flood</event><severity>Severe</severity><urgency>Immediate</urgency>
    <headline>Shutters of Mettur dam opened, surplus water release</headline>
    <expires>2026-10-24T09:00:00+05:30</expires>
    <area><areaDesc>Salem</areaDesc><polygon>11.7,77.7 11.9,77.7 11.9,77.9 11.7,77.9 11.7,77.7</polygon></area>
    <area><areaDesc>Erode</areaDesc><circle>11.34,77.72 15</circle></area>
  </info>
</alert>`;

test('parseCap picks the English info block and extracts areas', () => {
  const a = parseCap(CAP);
  assert.equal(a.identifier, 'X-1');
  assert.equal(a.event, 'Flood');
  assert.equal(a.areaDesc, 'Salem; Erode');
  assert.equal(a.polygons.length, 1);
  assert.equal(a.circles[0].radiusKm, 15);
  assert.equal(a.expires, '2026-10-24T03:30:00.000Z');
  assert.ok(a.kinds.includes('dam') && a.kinds.includes('flood'));
});

test('parseCap rejects documents without an identifier and hostile documents', () => {
  assert.throws(() => parseCap('<alert><status>Actual</status></alert>'), /identifier/);
  assert.throws(() => parseCap('<!DOCTYPE a [<!ENTITY x "y">]><alert/>'), UnsafeXmlError);
});

test('classifyKinds recognizes dam, heat and fallbacks', () => {
  assert.deepEqual(classifyKinds('Vaigai dam: crest gates raised'), ['dam']);
  assert.ok(classifyKinds('Severe heat wave conditions').includes('heat'));
  assert.deepEqual(classifyKinds('Air quality advisory'), ['other']);
  assert.ok(!classifyKinds('random fundamentals').includes('dam'), 'whole words only');
});

test('parseRss extracts items and unwraps CDATA titles', () => {
  const items = parseRss('<rss><channel><item><title><![CDATA[A & B]]></title><link>https://x/1</link></item><item><title>no link</title></item></channel></rss>');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'A & B');
});

/* ---------- Heat (IMD criteria) ---------- */

test('classifyHeatDay applies IMD thresholds', () => {
  assert.equal(classifyHeatDay(47.2, 'plains'), 'severe');
  assert.equal(classifyHeatDay(45.0, 'plains'), 'heatwave');
  assert.equal(classifyHeatDay(42, 'plains'), null, 'no normal: only absolute criterion');
  assert.equal(classifyHeatDay(42, 'plains', 37), 'heatwave', 'departure 5.0');
  assert.equal(classifyHeatDay(42, 'plains', 35), 'severe', 'departure 7.0');
  assert.equal(classifyHeatDay(39, 'plains', 33), null, 'below plains threshold');
  assert.equal(classifyHeatDay(38, 'coastal', 33), 'heatwave', 'coastal threshold 37');
  assert.equal(classifyHeatDay(31, 'hilly', 24), 'severe', 'hilly threshold 30');
});

test('assessHeat needs two consecutive qualifying days', () => {
  const p = { region: 'plains', days: [{ date: '2026-05-01', tmax: 45.5 }, { date: '2026-05-02', tmax: 41 }, { date: '2026-05-03', tmax: 45.2 }] };
  assert.equal(assessHeat(p, null).alert, null);
  const p2 = { region: 'plains', days: [{ date: '2026-05-01', tmax: 45.5 }, { date: '2026-05-02', tmax: 46 }] };
  assert.equal(assessHeat(p2, null).alert.severity, 'high');
  const p3 = { region: 'plains', days: [{ date: '2026-05-01', tmax: 47.5 }, { date: '2026-05-02', tmax: 48 }] };
  assert.equal(assessHeat(p3, null).alert.severity, 'critical');
});

/* ---------- River discharge ---------- */

test('assessRiver uses absolute levels first, then ratios gated by a floor', () => {
  const base = { peak: 200, baseline: 40, ratio: 5, minDischarge: 30, warningLevel: null, dangerLevel: null };
  assert.equal(assessRiver(base).severity, 'high');
  assert.equal(assessRiver({ ...base, ratio: 2.5 }).severity, 'medium');
  assert.equal(assessRiver({ ...base, ratio: 1.2 }), null);
  assert.equal(assessRiver({ ...base, peak: 20, ratio: 5 }), null, 'below floor');
  assert.equal(assessRiver({ ...base, dangerLevel: 150 }).severity, 'critical');
  assert.equal(assessRiver({ ...base, ratio: 1, warningLevel: 180 }).severity, 'high');
});

/* ---------- Notifications ---------- */

const alert = (severity, origin = 'official') => ({ severity, origin, title: `${severity} thing`, source: 'src', summary: 's', zones: ['Z'] });

test('formatAlert labels derived alerts as unofficial', () => {
  assert.match(formatAlert(alert('high', 'derived')), /Derived \(not an official warning\)/);
  assert.match(formatAlert(alert('high', 'official')), /^\[HIGH\]/);
});

test('buildMessages sends urgent alerts individually, digests the rest, and caps volume', () => {
  const msgs = buildMessages([alert('medium'), alert('critical'), alert('low'), alert('high')]);
  assert.equal(msgs.length, 3);
  assert.match(msgs[0], /CRITICAL/);
  assert.match(msgs[2], /digest: 1 alert/);
  const flood = buildMessages(Array.from({ length: 30 }, () => alert('critical')));
  assert.equal(flood.length, 8);
  assert.match(flood[7], /digest: 23 alert/);
});

/* ---------- Rules: earthquake zone scoping ---------- */

test('ordinary quakes use usgs.zones; tsunami-flagged quakes use every zone', () => {
  const config = {
    zones: [{ id: 'small', lat: 11, lng: 78.6, radiusKm: 450 }, { id: 'big', lat: 22, lng: 80, radiusKm: 2200 }],
    usgs: { minMagnitude: 4.5, zones: ['small'] }
  };
  const quake = (id, lat, lng, mag, tsunami) => ({ id, lat, lng, mag, tsunami, place: id, depthKm: 10 });
  const out = evaluate({
    config,
    data: { quakes: [quake('tibet', 31.5, 92, 5.2, false), quake('andaman', 12.4, 92.9, 6.8, true), quake('tn', 11.2, 78.4, 4.6, false)] }
  });
  assert.deepEqual(out.map((a) => a.key).sort(), ['usgs:andaman', 'usgs:tn']);
  assert.equal(out.find((a) => a.key === 'usgs:andaman').severity, 'critical');
});

/* ---------- District gazetteer and SACHET severity ---------- */

test('matchPlaces finds whole-word district names and aliases', () => {
  const g = loadGazetteer();
  assert.deepEqual(matchPlaces('Coimbatore, Dindigul, Madurai, Namakkal districts of Tamil Nadu', g).map((p) => p.name),
    ['Coimbatore', 'Dindigul', 'Madurai', 'Namakkal']);
  assert.deepEqual(matchPlaces('Heavy rain over Trichy and Tuticorin', g).map((p) => p.name), ['Thoothukudi', 'Tiruchirappalli']);
  assert.deepEqual(matchPlaces('Salemville and Karurpet', g), [], 'no partial-word matches');
});

test('sachetSeverity scales routine rain but keeps hazard severity', () => {
  const a = (event, severity, headline = '') => ({ event, severity, headline });
  assert.equal(sachetSeverity(a('Moderate Rain', 'Severe'), 'thunderstorm'), 'low');
  assert.equal(sachetSeverity(a('Very Heavy Rain', 'Severe'), 'rain'), 'medium');
  assert.equal(sachetSeverity(a('Extremely Heavy Rain', 'Severe'), 'rain'), 'high');
  assert.equal(sachetSeverity(a('Rain', 'Extreme'), 'rain'), 'high');
  assert.equal(sachetSeverity(a('Flood', 'Severe'), 'flood'), 'high');
  assert.equal(sachetSeverity(a('Heat Wave', 'Extreme'), 'heat'), 'critical');
});

test('parseCap locates SACHET-style alerts without geometry by district names', () => {
  const xml = `<cap:alert xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2"><cap:identifier>IN-1</cap:identifier>
    <cap:status>Actual</cap:status><cap:msgType>Alert</cap:msgType>
    <cap:info><cap:language>en-IN</cap:language><cap:event>Flood</cap:event><cap:severity>Severe</cap:severity>
    <cap:headline>Flood warning issued by IMD Chennai</cap:headline>
    <cap:area><cap:areaDesc>Namakkal, Madurai districts of Tamil Nadu</cap:areaDesc>
      <cap:geocode><cap:valueName>LGD District Code</cap:valueName><cap:value>578</cap:value></cap:geocode></cap:area></cap:info></cap:alert>`;
  const a = parseCap(xml);
  assert.deepEqual(a.places.map((p) => p.name), ['Madurai', 'Namakkal'], 'areaDesc wins; "Chennai" in the headline is ignored');
  assert.equal(a.locatedBy, 'district-names');
  assert.ok(Math.abs(a.lat - 10.575) < 0.01 && Math.abs(a.lng - 78.145) < 0.01);
  assert.deepEqual(a.geocodes, [{ name: 'LGD District Code', value: '578' }]);
});

test('headline fallback is limited to the state named in areaDesc', () => {
  const capWith = (areaDesc, headline) => parseCap(`<alert><identifier>X</identifier><status>Actual</status><info>
    <language>en-IN</language><event>Very Heavy Rain</event><headline>${headline}</headline>
    <area><areaDesc>${areaDesc}</areaDesc></area></info></alert>`);
  const headline = 'Very heavy rain over Idukki, Kollam Districts and in Lakshadweep islands';
  assert.deepEqual(capWith('10 districts of Kerala', headline).places.map((p) => p.name), ['Idukki', 'Kollam']);
  assert.deepEqual(capWith('Lakshadweep District district of Lakshadweep', headline).places, [], 'not placed in Kerala');
  assert.equal(capWith('Lakshadweep District district of Lakshadweep', headline).locatedBy, 'none');
});

test('GDACS earthquakes follow usgs.zones; cyclones use every zone', () => {
  const config = {
    zones: [{ id: 'small', lat: 11, lng: 78.6, radiusKm: 450 }, { id: 'big', lat: 22, lng: 80, radiusKm: 2200 }],
    usgs: { zones: ['small'] }, gdacs: { minLevel: 'Orange' }
  };
  const ev = (id, type, lat, lng) => ({ id, type, name: id, alertLevel: 'Red', lat, lng, country: '' });
  const out = evaluate({ config, data: { gdacs: [ev('tibet-eq', 'Earthquake', 31.5, 92), ev('bay-tc', 'Tropical cyclone', 14.5, 86)] } });
  assert.deepEqual(out.map((a) => a.key), ['gdacs:bay-tc:Red']);
});

test('per-request timeout overrides the client default', async () => {
  const slow = (url, { signal }) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(new Response('ok', { status: 200 })), 80);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
  });
  const http = createHttpClient({ allowedHosts: ['ok.example'], userAgent: 't', timeoutMs: 20, fetchImpl: slow });
  await assert.rejects(http.getText('https://ok.example/a'), /timeout after 0.02s/);
  assert.equal((await http.getText('https://ok.example/a', { timeoutMs: 500 })).text, 'ok');
});

test('http client aborts bodies over the size cap while streaming', async () => {
  const { createHttpClient } = await import('../lib/http.mjs');
  const chunk = new Uint8Array(1024 * 1024).fill(65);
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent++ < 20) controller.enqueue(chunk); else controller.close();
    }
  });
  const fetchImpl = async () => new Response(body, { status: 200 });
  const http = createHttpClient({ allowedHosts: ['example.org'], userAgent: 'test', fetchImpl });
  await assert.rejects(() => http.getText('https://example.org/big'), /too large/);
  assert.ok(sent < 12, `stopped early (read ${sent} MB)`);
});

test('reservoir page parses all 19 dams with known positions', async () => {
  const { readFile } = await import('node:fs/promises');
  const { parseReservoirPage, RESERVOIR_SITES } = await import('../sources/reservoirs.mjs');
  const html = await readFile(new URL('./fixtures/tnagriculture.in_people_app_more_reservoir_en_2026-10-23', import.meta.url), 'utf8');
  const page = parseReservoirPage(html);
  assert.equal(page.date, '2026-10-23');
  assert.equal(page.items.length, 19);
  const unknown = page.items.filter((r) => !RESERVOIR_SITES[r.id]).map((r) => r.id);
  assert.deepEqual(unknown, [], 'every dam maps to a site with coordinates');
  const mettur = page.items.find((r) => r.id === 'mettur');
  assert.deepEqual([mettur.fullFt, mettur.levelFt, mettur.inflow, mettur.outflow], [120, 54.56, 1409, 2254]);
  const sathanur = page.items.find((r) => r.id === 'sathanur');
  assert.equal(sathanur.outflow, null, 'blank cells become null, not 0');
});

test('reservoir parser fails loudly when the layout changes', async () => {
  const { parseReservoirPage } = await import('../sources/reservoirs.mjs');
  assert.throws(() => parseReservoirPage('<html><body>maintenance</body></html>'), /As On Date/);
  assert.throws(() => parseReservoirPage('<p class="tt"><span>As On Date:</span> <span>24-10-2026</span></p>'), /no reservoirs/);
});

test('reservoir rules: large release, gate-opening jump, near full', async () => {
  const { assessReservoir } = await import('../sources/reservoirs.mjs');
  const base = { fullFt: 120, levelFt: 80, releaseHigh: 30000 };
  assert.deepEqual(assessReservoir({ ...base, outflow: 61000, prevOutflow: 60000 }), [{ type: 'release', severity: 'critical' }]);
  assert.deepEqual(assessReservoir({ ...base, outflow: 31000, prevOutflow: 30500 }), [{ type: 'release', severity: 'high' }]);
  assert.deepEqual(assessReservoir({ ...base, outflow: 9000, prevOutflow: 2000 }), [{ type: 'release', severity: 'medium' }]);
  assert.deepEqual(assessReservoir({ ...base, outflow: 18000, prevOutflow: 15000 }), [], 'routine irrigation release changes do not alert');
  assert.deepEqual(assessReservoir({ ...base, levelFt: 117.5, outflow: 100 }), [{ type: 'full', severity: 'medium' }]);
  assert.deepEqual(assessReservoir({ ...base, levelFt: 119.8, outflow: null }), [{ type: 'full', severity: 'high' }]);
});

test('websocket frames: masked client frames round-trip, server frames reassemble, oversize rejected', async () => {
  const { encodeFrame, parseFrames } = await import('../lib/ws.mjs');
  const text = 'x'.repeat(70000);
  const { frames, rest } = parseFrames(encodeFrame(0x1, Buffer.from(text)));
  assert.equal(rest.length, 0);
  assert.equal(frames[0].payload.toString(), text, '64-bit length, masked');
  const server = (fin, opcode, body) => Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, body.length]), body]);
  const two = Buffer.concat([server(false, 0x1, Buffer.from('{"a":')), server(true, 0x0, Buffer.from('1}'))]);
  const half = parseFrames(two.subarray(0, 4));
  assert.equal(half.frames.length, 0, 'incomplete frame waits for more bytes');
  const all = parseFrames(two);
  assert.equal(Buffer.concat(all.frames.map((f) => f.payload)).toString(), '{"a":1}');
  assert.deepEqual(all.frames.map((f) => f.fin), [false, true]);
  const huge = Buffer.alloc(10);
  huge[0] = 0x82; huge[1] = 127; huge.writeBigUInt64BE(BigInt(1e9), 2);
  assert.equal(parseFrames(huge).error, 'frame too large');
});

const aisPosition = (mmsi, lat, lng, extra = {}) => JSON.stringify({
  MessageType: 'PositionReport',
  MetaData: { MMSI: mmsi, ShipName: 'TEST VESSEL  ', latitude: lat, longitude: lng, time_utc: '2026-10-24 15:00:00.123456 +0000 UTC' },
  Message: { PositionReport: { Latitude: lat, Longitude: lng, Sog: 12.3, Cog: 87.5, TrueHeading: 88, NavigationalStatus: 0, UserID: mmsi, Valid: true, ...extra } }
});

test('AIS messages: positions and static data parsed, junk rejected', async () => {
  const { parseAisMessage } = await import('../sources/ships.mjs');
  const p = parseAisMessage(aisPosition(419000123, 13.1, 80.3));
  assert.deepEqual([p.mmsi, p.name, p.position.lat, p.position.sog, p.position.heading], [419000123, 'TEST VESSEL', 13.1, 12.3, 88]);
  assert.equal(new Date(p.position.time).toISOString(), '2026-10-24T15:00:00.123Z');
  const s = parseAisMessage(JSON.stringify({
    MessageType: 'ShipStaticData', MetaData: { MMSI: 419000123, ShipName: 'TEST VESSEL' },
    Message: { ShipStaticData: { Name: 'TEST VESSEL@@@', Type: 70, Destination: 'CHENNAI@@', CallSign: 'AB12', Dimension: { A: 120, B: 30, C: 10, D: 12 } } }
  }));
  assert.deepEqual(s.static, { name: 'TEST VESSEL', type: 70, destination: 'CHENNAI', callsign: 'AB12', lengthM: 150 });
  assert.equal(parseAisMessage('not json'), null);
  assert.equal(parseAisMessage(aisPosition(123, 13, 80)), null, 'invalid MMSI');
  assert.equal(parseAisMessage(aisPosition(419000124, 0, 0)), null, 'null island position dropped');
  assert.equal(parseAisMessage(aisPosition(419000125, 95, 80)), null, 'out-of-range latitude');
  assert.deepEqual(parseAisMessage('{"error":"Api Key Is Not Valid"}'), { error: 'Api Key Is Not Valid' });
});

test('ships: listen window, server error and merge with ageing', async () => {
  const { listenShips, mergeShips } = await import('../sources/ships.mjs');
  const fakeConnect = (messages) => async (url, { onMessage, onClose }) => {
    let sent = null;
    return {
      send: (t) => { sent = JSON.parse(t); setTimeout(() => { for (const m of messages) onMessage(m); }, 5); },
      close: () => { assert.ok(sent && sent.APIKey === 'k' && sent.BoundingBoxes, 'subscribed with key and box'); onClose('closed by client'); }
    };
  };
  const heard = await listenShips({ apiKey: 'k', listenMs: 30, connect: fakeConnect([aisPosition(419000123, 13.1, 80.3), aisPosition(419000124, 12, 81)]) });
  assert.equal(heard.positions.size, 2);
  await assert.rejects(() => listenShips({ apiKey: 'k', listenMs: 30, connect: fakeConnect(['{"error":"Api Key Is Not Valid"}']) }), /Api Key/);
  await assert.rejects(() => listenShips({ apiKey: '', connect: fakeConnect([]) }), /not set/);

  const now = Date.parse('2026-10-24T15:05:00Z');
  const state = { ships: { 111000111: { lat: 1, lng: 2, time: now - 4 * 3600 * 1000 } } };
  const rows = mergeShips(state, heard, now);
  assert.equal(rows.length, 2, 'ship older than 3 hours dropped');
  assert.equal(rows[0][1], 'TEST VESSEL');
});

test('reservoir history: merge by date, find gaps, backfill a few days per run', async () => {
  const { addToHistory, missingDates, backfillHistory } = await import('../sources/reservoirs.mjs');
  const page = (date, level) => ({ date, items: [{ id: 'mettur', fullFt: 120, levelFt: level, inflow: 1000, outflow: 2000 }] });
  let h = addToHistory(null, page('2026-10-24', 54.5));
  h = addToHistory(h, page('2026-10-23', 54.6));
  h = addToHistory(h, page('2026-10-24', 54.56));
  assert.deepEqual(h.dams.mettur.map((r) => [r[0], r[1]]), [['2026-10-23', 54.6], ['2026-10-24', 54.56]], 'sorted, same date replaced');
  assert.equal(missingDates(h, '2026-10-24', 5).join(','), '2026-10-22,2026-10-21,2026-10-20,2026-10-19');

  const html = (dmy) => `<p><span>As On Date:</span> <span class="x"> ${dmy}</span></p><h4 class="date-tt h-tt">METTUR</h4>
    <ul class="leg1 d-flex"><li>Full Depth</li></ul><ul class="leg1 d-flex"><li>(Feet)</li></ul><ul class="leg1 d-flex"><li>120</li><li>53.9</li><li>900</li><li>2100</li></ul>`;
  const requested = [];
  const http = { getText: async (url) => {
    const d = url.slice(-10);
    requested.push(d);
    if (d === '2026-10-21') throw new Error('HTTP 500');
    if (d === '2026-10-20') return { text: html('24-10-2026') };   /* site returned the wrong day */
    const [y, m, dd] = d.split('-');
    return { text: html(`${dd}-${m}-${y}`) };
  } };
  const r = await backfillHistory({ http, history: h, latest: '2026-10-24', maxFetch: 3 });
  assert.deepEqual(requested, ['2026-10-22', '2026-10-21', '2026-10-20']);
  assert.ok(r.history.dams.mettur.some((x) => x[0] === '2026-10-22'), 'good day added');
  assert.deepEqual(r.unavailable, ['2026-10-20', '2026-10-21'], 'failed and mismatched days are skipped next time');
  const r2 = await backfillHistory({ http, history: r.history, latest: '2026-10-24', unavailable: r.unavailable, maxFetch: 1 });
  assert.equal(requested[requested.length - 1], '2026-10-19', 'next run moves on to older days');
  assert.ok(r2.history.dams.mettur.some((x) => x[0] === '2026-10-19'));
});

test('rain: IMD 24-hour categories on the forecast peak day', async () => {
  const { assessRain } = await import('../sources/openmeteo.mjs');
  assert.equal(assessRain({ peakMm: 115.5 }), null, 'heavy (below very heavy) does not alert');
  assert.equal(assessRain({ peakMm: 115.6 }).severity, 'medium');
  assert.equal(assessRain({ peakMm: 204.5 }).severity, 'high');
  assert.equal(assessRain({ peakMm: null }), null);
});

test('telegram commands: only the owner chat is answered, offset advances, replies are bounded', async () => {
  const { handleCommands, answerCommand } = await import('../commands.mjs');
  const latest = {
    generatedAt: '2026-10-24T17:52:22Z', heartbeat: { ok: true, configured: true },
    health: { sachet: { ok: true }, ships: { ok: false } },
    active: [{ severity: 'high', title: 'Large release: Mettur', origin: 'derived' }],
    layers: {
      reservoirs: { date: '2026-10-24', items: [{ name: 'Mettur (Stanley)', levelFt: 54.56, fullFt: 120, pctDepth: 45.5, inflow: 1409, outflow: 2254, levelChangeFt: -0.12 }] },
      rain: [{ name: 'Nilgiris', state: 'Tamil Nadu', next72: 255, peakMm: 130, peakDate: '2026-10-24' }]
    }
  };
  assert.match(answerCommand('/status', latest), /updated 23:22 IST 2026-10-24[\s\S]*Sources ok 1\/2 \(failing: ships\)[\s\S]*1 high/);
  assert.match(answerCommand('/dams@OsiBot', latest), /Mettur \(Stanley\): 54\.56\/120 ft \(-0\.12 ft\), in 1,409, out 2,254/);
  assert.match(answerCommand('/rain', latest), /Nilgiris: 255 mm total/);
  assert.match(answerCommand('/whatever', latest), /Unknown command/);

  const sent = [];
  const updates = [
    { update_id: 10, message: { chat: { id: 979 }, text: '/status' } },
    { update_id: 11, message: { chat: { id: 123 }, text: '/dams' } },
    { update_id: 12, message: { chat: { id: 979 }, text: 'hello' } },
    ...Array.from({ length: 8 }, (_, i) => ({ update_id: 13 + i, message: { chat: { id: 979 }, text: '/alerts' } }))
  ];
  let calledUrl = '';
  const fetchImpl = async (url) => { calledUrl = url; return new Response(JSON.stringify({ ok: true, result: updates })); };
  const r = await handleCommands({ token: 'T', chatId: '979', offset: 10, latest, send: async (t) => sent.push(t), fetchImpl });
  assert.match(calledUrl, /getUpdates\?offset=10/);
  assert.equal(r.offset, 21, 'offset moves past every update, answered or not');
  assert.equal(sent.length, 5, 'at most five replies per run');
  assert.ok(!sent.some((t) => /Reservoirs/.test(t)), 'other chats get no reply');
  const failed = await handleCommands({ token: 'T', chatId: '979', offset: 21, latest, send: async () => {}, fetchImpl: async () => new Response('{}', { status: 409 }) });
  assert.equal(failed.offset, 21, 'webhook conflict leaves the offset unchanged');
});

test('TLE fallback: SatNOGS records convert to three-line text', async () => {
  const { satnogsToTle, cleanTle } = await import('../sources/tle.mjs');
  const l1 = '1 25544U 98067A   26297.20915682  .00007800  00000+0  14234-3 0  9993';
  const l2 = '2 25544  51.6390 123.4567 0003456  78.9012 281.2345 15.50000000 12345';
  const text = cleanTle(satnogsToTle([{ tle0: '0 ISS (ZARYA)', tle1: l1, tle2: l2 }, { tle0: '0 BROKEN', tle1: 'x', tle2: null }]));
  assert.equal(text, `ISS (ZARYA)\n${l1}\n${l2}`);
  assert.equal(satnogsToTle({ detail: 'error' }), '');
});
