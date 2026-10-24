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
