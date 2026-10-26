# OSI Monitor — Design

## Goal

Surface **new or escalating** hazards that matter to the configured watch zones (default: Tamil Nadu and the Indian subcontinent), including when the dashboard is closed, while making it impossible for the monitor to fail silently.

This is a personal context and cross-checking tool. It is **not** a primary warning system: the official SACHET app and cell-broadcast SMS reach people faster and do not depend on GitHub.

## Architecture

```
                 ┌──────────────── GitHub Actions (every 15 min) ────────────────┐
 SACHET (CAP) ──▶│                                                                │
 Open-Meteo  ──▶ │  poller/index.mjs                                              │──▶ Telegram: alerts (with
 GDACS, USGS ──▶ │  fetch ─▶ normalize ─▶ rules ─▶ de-duplicate ─▶ filter ─▶ notify│    feedback buttons), 07:00
 FIRMS, GDELT ─▶ │                         │                     (overrides, mutes)│    digest, Sunday review
 WRD, OpenSky ─▶ │                         │                                      │──▶ healthchecks.io (heartbeat)
 AIS, CelesTrak ▶│                         └─▶ data branch: latest.json, events.json, state.json,
                 │                             fires.json, news.json, tle.json, weekly-log.json, briefs/
                 └────────────────────────────────────────────────────────────────┘
                                                   │ public raw.githubusercontent.com
 Browser dashboard ◀── live: USGS, GDACS, EONET, Windy, RainViewer, NASA GIBS, Esri
                   ◀── poller: alerts, cyclones, sea, fires, news, flights, ships, satellites

 CI on every push: syntax and import checks ─▶ poller tests ─▶ headless-Chrome test ─▶ publish `site` branch (Pages)
```

**Split of responsibilities**

| Concern | Where | Why |
|---|---|---|
| Base map | Browser, streamed tiles | Esri World Imagery (+ Esri reference roads and places for Hybrid) or Esri Dark Gray (CARTO's free tiles now require a key), as Web Mercator XYZ tiles. A quadtree picks tiles per frame (split while a tile would exceed 256 px on screen, with horizon and frustum culling). Meshes are built relative to each tile's centre to avoid float32 jitter near the ground; a missing tile shows its nearest loaded ancestor cropped, then cross-fades. Requests are capped (10 desktop, 6 phone), aborted when a tile leaves view, and textures are evicted least-recently-used (360 / 180). Markers and lines are lifted above the surface by a factor that shrinks with eye altitude, so they sit on the imagery up close. |
| Weather overlay | Browser, streamed tiles | RainViewer radar (512 px tiles, zoom 7 max, latest of 13 ten-minute frames), NASA GIBS IMERG 30-minute rain rate and Himawari band 13 infrared (zoom 6 max). Requested one level coarser than the imagery, through a per-source token bucket (RainViewer allows 100 requests per minute per IP). A new frame keeps the previous one visible until it loads. Sources, formats, CORS and zoom limits were verified from a GitHub runner with the `diagnose` task. |
| Satellites | Poller TLEs (CelesTrak `active`, ~16,000), propagated in a Web Worker | Keyframes every 10 s for all satellites off the main thread, interpolated ~30 times a second into the GPU buffer; the selected satellite is propagated exactly. satellite.js for the worker is served from `src/vendor` (same SHA-384 as the upstream npm build). CelesTrak asks clients not to download more than every two hours, so the poller republishes TLEs every 6 hours.. |
| Flights | Poller snapshot, projected in the browser | OpenSky only allows its own site to read its API from a browser (CORS), so the poller fetches it every 30 min (4 of ~400 free daily credits per request) and the dashboard dead-reckons each aircraft along its track. Emergency squawks in zones also alert via Telegram. Flights are an auxiliary source: failures never trigger degraded notices. |
| SACHET (flood, heat, dam, cyclone) | Poller | Feeds send no CORS headers; a browser cannot read them. |
| River-rise and heat-wave signals | Poller | Needs batching, state and baselines. |
| Ships | Poller, projected in the browser | AISStream is a WebSocket API with a key, so the poller listens for 45 s per run (zero-dependency RFC 6455 client in `poller/lib/ws.mjs`, size-capped), merges with ships heard in the last 3 hours and publishes `ships.json`. Auxiliary: failures never page. |
| Reservoirs | Poller | Official daily WRD figures, compared with the previous day's page; drives dam-release alerts. Daily history is kept in `reservoir-history.json` (400 days), backfilled from dated pages four days per run; days the site cannot serve are remembered and skipped. |
| Live players | Browser | YouTube (privacy-enhanced, channel live embed) and Windy players, framed only on tap; CSP `frame-src` allows just those two hosts. |
| District rain | Poller | 56 gazetteer districts in one batched Open-Meteo request, hourly (each location counts toward the free daily quota). Very heavy (115.6 mm/day) and extremely heavy (204.5) forecasts become derived alerts. |
| Telegram commands | Poller | `getUpdates` once per run with a stored offset (messages and button taps); only the configured chat is answered, at most five replies per run, plain text. |
| Cyclones | Poller | GDACS event list each run, filtered to current North Indian Ocean storms; each storm's geometry (about 200 KB) only when GDACS issues a new episode. Track points are the centres of GDACS's point circles, with intensity from the segment starting there; landfall is the first crossing of the forecast track with a 37-point Indian coastline, time interpolated along the segment. |
| Sea state | Poller | One batched Open-Meteo Marine request for 11 offshore points, hourly; one coast-wide alert per severity and day. |
| Fires | Poller | FIRMS' keyless 24-hour South Asia VIIRS files from three satellites, low-confidence rows dropped, merged on a ~1 km grid (strongest kept), capped at 8,000 rows in `fires.json`. |
| News | Poller | One GDELT DOC request an hour (shared runner addresses get HTTP 429, so it retries twice with backoff), English and Indian sources only, placed by the most specific place in the headline (TN district, city, then state; ambiguous names such as Erode need "in/at/near"), near-duplicates merged. Never alerts. |
| Digest, review, brief | Poller | Each run updates a 14-day daily log; at 07:00 IST the digest goes out once a day; on Sunday the weekly review and a Markdown brief (`briefs/YYYY-Www.md`) built only from the log. |
| Notifications | Poller | Must work with the dashboard closed. |

## Sources

| Source | Data | Official? | Notes |
|---|---|---|---|
| NDMA SACHET | CAP 1.2 alerts via RSS | Official | IMD, state disaster authorities, INCOIS. Each CAP document is fetched once per identifier. Located by district name (see below). |
| Open-Meteo Flood API | GloFAS river discharge, 7 days back / 7 ahead | Derived | No return-period thresholds, so the default test is relative (peak vs 7-day mean) with an absolute floor. Per-point `warningDischarge` / `dangerDischarge` override it. |
| Open-Meteo Forecast API | Daily max temperature | Derived | Evaluated against IMD station criteria (below). |
| Open-Meteo Archive | 1991–2020 daily max | — | One-off monthly normals per heat point (`build-normals` task). |
| GDACS | Global disaster alerts (`SEARCH` endpoint, current events only) | Official | Orange/Red inside zones. Re-fires on escalation. The `MAP` endpoint now rejects requests. |
| USGS | Earthquakes M2.5+ (24 h) | Official | M4.5+ inside `usgs.zones` (Tamil Nadu by default); tsunami-flagged quakes inside any zone. A 2,200 km circle over India also covers Tibet, so it is not used for ordinary quakes. |
| GDACS geometry | Cyclone track, cone, wind swaths | Forecast (JTWC) | Rule `cyclone_track`: forecast track within `cyclones.withinKm` (400 km) of a sea point; 150 km tier is high. GDACS level changes are left to the GDACS rule so one escalation is not sent twice. |
| Open-Meteo Marine | Significant wave height | Derived | Rule `sea_state`: WMO rough (2.5 m) medium, very rough (4 m) high, next 48 h. INCOIS high-wave alerts arrive through SACHET. |
| NASA FIRMS | VIIRS hotspots, 24 h | Observed | Rule `forest_fire`: at least `fires.minDetections` (3) inside a watched forest area; three times that is high. |
| GDELT DOC 2.0 | Headlines | Unverified | Dashboard, digest and weekly brief only. |

### Locating SACHET alerts

Verified against live SACHET data from a GitHub runner:

- CAP messages contain **no inline `<polygon>`**. Areas are LGD district codes plus a "Polygon URL" parameter.
- The polygon URLs return **HTTP 403** to automated clients.
- The English `areaDesc` reliably names districts ("Coimbatore, Dindigul, Madurai districts of Tamil Nadu"); some alerts name them only in the headline ("10 districts of Kerala").

So alerts are located by matching district names (areaDesc first, then headline) against a small gazetteer of Tamil Nadu, Puducherry and neighbouring districts (`poller/data/districts.json`), using approximate headquarters coordinates. Neighbouring Kerala, Karnataka and Andhra districts are included because rain there feeds Tamil Nadu rivers and dams (e.g. Idukki for Mullaperiyar and Vaigai). LGD codes are retained for a future code-based lookup. Positions are indicative, not boundaries.

CAP `Update` and `Cancel` messages remove the alerts they reference, so a revised nowcast replaces the original instead of duplicating it.

### Severity policy

IMD issues rain and thunderstorm nowcasts several times a day, often tagged CAP "Severe". Passing that straight through would page the owner for routine weather. Rain and thunderstorm alerts are therefore scaled: routine → low (dashboard only), "very heavy" → medium (digest), "extremely heavy" or CAP "Extreme" → high. Flood, dam release, heat, cyclone and tsunami keep the issuing agency's severity.

### Dam releases

There is no public machine-readable feed of dam releases in India. CWC publishes **weekly** reservoir storage bulletins, not release events. Releases are announced by state water resources departments and district collectors, and only sometimes through SACHET. The Tamil Nadu Agriculture Department republishes WRD's **daily** level, inflow and outflow for 19 dams; the poller reads it hourly and compares outflow with the previous day, so a gate opening shows up within a day.

The monitor therefore detects dam releases from SACHET alert text (dam, reservoir, shutter, spillway, crest gate, surplus release, outflow) and models river rise below dams with GloFAS. Coverage is partial by nature; this is stated rather than papered over.

### Heat wave criteria (IMD)

- Region threshold must be reached: 40 °C plains, 37 °C coastal, 30 °C hilly.
- Departure from normal 4.5–6.4 °C = heat wave; above 6.4 °C = severe.
- Independently of normal: actual max ≥ 45 °C = heat wave, ≥ 47 °C = severe.
- Must hold on **two consecutive days**.

IMD also requires the criteria at two stations in a subdivision; a single forecast point cannot satisfy that, which is one reason these alerts are labelled *derived*. Until normals are built, only the absolute criterion can fire.

## Alert lifecycle

1. **Candidates**: every rule emits alerts with a stable `key`.
2. **Baseline**: on the very first run, everything already active is recorded but not sent; a single "monitor started" summary is sent instead.
3. **De-duplication**: a key notifies once per 3-day window. Escalations (GDACS Orange→Red, river medium→high) produce a new key and notify again.
4. **Filter**: `ruleOverrides` (per-rule `minSeverity` or `enabled: false`) and `/mute <group> [days]` (at most 30) hold alerts back from Telegram; they are still recorded as events and shown on the dashboard.
5. **Delivery**: critical/high as individual messages; medium as one digest; hard cap of 8 messages per run. Each message carries Useful / Noise buttons (callback data `fb:<u|n>:<10-hex id>`; the id maps to the alert keys in state for 21 days).
6. **Labelling**: every message states *Official* or *Derived (not an official warning)* and links its source.
7. **Review**: on Sunday, alerts fired in the last 7 days are counted per rule group with their ratings; a group with at least 3 ratings, half or more noise, gets a suggested config change or mute.

## Efficiency

- **Conditional requests** (ETag / Last-Modified) for feeds; unchanged feeds are not re-parsed.
- **CAP documents fetched once**, remembered for 7 days, including rejected ones.
- **Batched coordinates**: one Open-Meteo request per API regardless of point count.
- **Parallel sources**, no dependencies to install: a run takes seconds; billing is per started minute.
- **Single-commit data branch**: rewritten each run, so the repository does not grow.
- **Schedule** at minutes 7, 22, 37 and 52 (top-of-hour schedules are the most delayed). Actions minutes are free on public repositories; a private repo would need 30-minute polling to fit GitHub Free's 2,000 minutes.
- **Heat baselines are incremental**: a 30-year download counts as about 780 calls against Open-Meteo's free 10,000/day, so a daily job builds missing stations and stops cleanly at HTTP 429.
- **River points are calibrated**: `calibrate-rivers` scans a 7x7 grid of GloFAS cells around each point and reports the cell carrying the river. Picks are reviewed by hand, because the strongest nearby cell can belong to a different river (at Karur it was the Cauvery, not the Amaravathi).

## Safety

### Reliability (silent failure is the primary risk)

- **Dead-man's switch**: each run pings `HEALTHCHECK_URL`; the external service alerts if pings stop (workflow disabled after 60 days without commits, GitHub outage, repeated crashes).
- **Degraded / recovered notices**: a source failing 3 runs in a row triggers one Telegram notice, and one more on recovery.
- **Total failure fails the job**, so GitHub also emails the repository owner.
- **Dashboard staleness**: poller output older than 90 minutes, or with failing sources, shows as *stale* rather than an empty "all clear".

### Input handling

- **XML**: no XML library; documents declaring a DOCTYPE or ENTITY are rejected outright, so XXE and entity-expansion attacks are impossible by construction. Only predefined and numeric entities are decoded.
- **HTTP allowlist**: the poller only fetches `https` URLs on known hosts, including after redirects, so a tampered feed cannot point the runner elsewhere.
- **Limits**: response size caps, timeouts, string length caps and control-character stripping on all feed text.
- **Rendering**: the dashboard HTML-escapes all external text; Telegram messages are sent as plain text (no markup parsing).

### Supply chain and secrets

- **Zero runtime dependencies** in the poller; Node built-ins only.
- **No third-party GitHub Actions**; checkout is a plain `git clone` with the job token.
- **Least privilege**: CI has `contents: read`; only the monitor job has `contents: write`, used solely to push the data and diagnostics branches. The token is passed per git command to the clone and publish steps only, never stored in git config, so the steps that parse untrusted feed data cannot read it.
- **Secrets** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `HEALTHCHECK_URL`, optional `MONITOR_CONFIG_JSON`) are passed only to the steps that need them and never logged.
- **Dashboard**: Content Security Policy allows scripts from this site only; three.js, satellite.js, topojson-client and the world-atlas outlines are vendored in `src/vendor` with their integrity hashes, so the page loads no third-party code.
- **Release gate**: the site is published to the `site` branch by CI only after syntax, import, poller and browser tests pass. The browser test blocks every non-local host inside Chrome, so it tests the code, not the availability of outside services.

### Dashboard code structure

`src/app/` holds ES modules split from the former single `app.js` by a one-off tool that tracked every top-level binding: declarations stay at module top level; start-up code that depends on other modules runs in an exported `init()`, which `index.js` calls in the original order, so evaluation order did not change. The thirteen variables that several modules reassign live in `app-state.js`, because imported bindings are read-only. `scripts/check-syntax.mjs` verifies every named import resolves to an export and that `sw.js` caches every file.

### Privacy

The repository is public. Coverage is deliberately state-wide (all of Tamil Nadu: 20 heat stations, 12 river points, every district in the gazetteer) so the configuration does not single out any one place. The `MONITOR_CONFIG_JSON` secret overrides `config/monitor.json` and keeps a configuration out of the repository files, but it does **not** make monitored places private: the poller's outputs (`latest.json` on the public data branch, the dashboard, diagnostics) still show every river point, heat station and zone. Truly private points need a private repository and a private data source for the dashboard.

Public-repo safeguards: the Monitor workflow only runs on schedule or manual dispatch (which requires write access), never on pull requests; CI runs on pull requests without secrets and with a read-only token; published data contains no secrets, and the heartbeat URL is recorded only as its host.

## Diagnostics

`Actions → Monitor → Run workflow → diagnose` fetches raw samples of every source from the runner (which can reach sources a developer machine may not), prints them, and pushes the output to a single-commit `diagnostics` branch. It sends nothing and does not touch the data branch. Use it when a source's format or endpoint changes.

## Known limits

- Imagery is flat (no terrain or 3D buildings) and the camera always looks straight down; Esri imagery dates and resolution vary by area.
- 15-minute polling plus possible GitHub scheduling delays: suited to hour-scale hazards only.
- SACHET is reachable from GitHub's runners (verified), but its polygon files are not; locations are district-level approximations.
- District matching depends on English district names; an alert that names no known district only matches via real geometry, which SACHET does not currently provide.
- The Tamil Nadu state SACHET feed URL is unconfirmed; only the national feed is configured.
- River points sit on GloFAS's ~5 km grid. Small urban rivers (Adyar) are poorly resolved by a global model; treat their signals as indicative.
- On public repositories GitHub disables scheduled workflows after 60 days without repository activity. The healthchecks.io dead-man's switch reports this; re-enable from the Actions tab or push any commit.

## Next steps

1. Add per-point `warningDischarge` / `dangerDischarge` levels where they are known.
2. Tune thresholds from the weekly review once a few weeks of Useful / Noise ratings exist.
