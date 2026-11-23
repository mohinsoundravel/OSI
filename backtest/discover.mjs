/* One-off: prints the shape of each archive the backtest will use. */
const get = async (label, url) => {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'OSI-Monitor/1.0 (backtest)' }, signal: AbortSignal.timeout(60000) });
    const text = await res.text();
    console.log(`\n===== ${label}\nGET ${url}\nHTTP ${res.status} ${text.length} chars\n${text.slice(0, 1500)}`);
    try { return JSON.parse(text); } catch { return null; }
  } catch (err) { console.log(`\n===== ${label}\nERROR ${err.message}`); return null; }
};
const loc = 'latitude=11.94,8.73&longitude=79.49,77.70&timezone=Asia%2FKolkata';
await get('previous runs (default model)', `https://previous-runs-api.open-meteo.com/v1/forecast?${loc}&hourly=precipitation,precipitation_previous_day1,precipitation_previous_day2,precipitation_previous_day3&start_date=2024-11-30&end_date=2024-11-30`);
await get('previous runs (daily?)', `https://previous-runs-api.open-meteo.com/v1/forecast?${loc}&daily=precipitation_sum,precipitation_sum_previous_day1&start_date=2024-11-30&end_date=2024-11-30`);
await get('single run ecmwf', `https://single-runs-api.open-meteo.com/v1/forecast?${loc}&daily=precipitation_sum&models=ecmwf_ifs&run=2024-11-28T00:00`);
await get('archive era5', `https://archive-api.open-meteo.com/v1/archive?${loc}&daily=precipitation_sum&start_date=2024-11-29&end_date=2024-12-01`);
await get('flood seamless past', `https://flood-api.open-meteo.com/v1/flood?latitude=11.76&longitude=79.70&daily=river_discharge&start_date=2024-11-25&end_date=2024-12-05`);
await get('flood forecast_v4 past', `https://flood-api.open-meteo.com/v1/flood?latitude=11.76&longitude=79.70&daily=river_discharge&models=forecast_v4&start_date=2024-11-25&end_date=2024-12-05`);
const list = await get('gdacs TC list', 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC&fromdate=2024-11-20&todate=2024-12-05&alertlevel=Green;Orange;Red&pageSize=50');
for (const f of list?.features || []) console.log('EVENT', f.properties.eventid, f.properties.episodeid, f.properties.eventname, f.properties.fromdate, f.properties.todate, f.geometry?.coordinates);
const fengal = (list?.features || []).find((f) => /FENGAL/i.test(f.properties.eventname || ''));
if (fengal) {
  const { eventid, episodeid } = fengal.properties;
  const data = await get('gdacs eventdata', `https://www.gdacs.org/gdacsapi/api/events/geteventdata?eventtype=TC&eventid=${eventid}`);
  console.log('EVENTDATA keys', data && Object.keys(data), data?.properties && Object.keys(data.properties));
  console.log('EPISODES', JSON.stringify(data?.properties?.episodes || data?.episodes || null)?.slice(0, 3000));
  for (const ep of [1, Math.max(1, Math.floor(Number(episodeid) / 2)), Number(episodeid)]) {
    const g = await get(`gdacs geometry episode ${ep}`, `https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=TC&eventid=${eventid}&episodeid=${ep}`);
    const feats = g?.features || [];
    console.log('GEOM', ep, feats.length, 'classes', [...new Set(feats.map((f) => f.properties?.Class))].join(','));
    const pt = feats.find((f) => String(f.properties?.Class || '').startsWith('Point_Polygon_Point'));
    console.log('POINT PROPS', JSON.stringify(pt?.properties || null));
    const ln = feats.find((f) => String(f.properties?.Class || '').startsWith('Line_Line'));
    console.log('LINE PROPS', JSON.stringify(ln?.properties || null));
  }
}
