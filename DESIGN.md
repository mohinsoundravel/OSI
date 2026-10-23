# OSI Monitor — Design

## Goal

Surface **new or escalating** hazards that matter to the configured watch zones (default: Tamil Nadu and the Indian subcontinent), including when the dashboard is closed, while making it impossible for the monitor to fail silently.

This is a personal context and cross-checking tool. It is **not** a primary warning system: the official SACHET app and cell-broadcast SMS reach people faster and do not depend on GitHub.

## Architecture

```
                 ┌──────────────── GitHub Actions (every 15 min) ────────────────┐
 SACHET (CAP) ──▶│                                                                │
 Open-Meteo  ──▶ │  poller/index.mjs                                              │──▶ Telegram
 GDACS, USGS ──▶ │  fetch ─▶ normalize ─▶ rules ─▶ de-duplicate ─▶ notify          │──▶ healthchecks.io (heartbeat)
                 │                         │                                      │
                 │                         └─▶ data branch: latest.json, events.json, state.json
                 └────────────────────────────────────────────────────────────────┘
                                                   │ public raw.githubusercontent.com
 Browser dashboard ◀── live: OpenSky, USGS, GDACS, EONET, CelesTrak, Windy
                   ◀── poller: India alerts layer (official + derived)
```

**Split of responsibilities**

| Concern | Where | Why |
|---|---|---|
| Base map | Browser, streamed tiles | Esri World Imagery (+ Esri reference roads and places for Hybrid) or Esri Dark Gray (CARTO's free tiles now require a key), as Web Mercator XYZ tiles. A quadtree picks tiles per frame (split while a tile would exceed 256 px on screen, with horizon and frustum culling). Meshes are built relative to each tile's centre to avoid float32 jitter near the ground; a missing tile shows its nearest loaded ancestor cropped, then cross-fades. Requests are capped (10 desktop, 6 phone), aborted when a tile leaves view, and textures are evicted least-recently-used (360 / 180). Markers and lines are lifted above the surface by a factor that shrinks with eye altitude, so they sit on the imagery up close. |
| Satellites | Poller TLEs, propagated in the browser | CelesTrak timed out from some browsers and asks clients not to re-download more than every two hours; the poller republishes TLEs every 6 hours (auxiliary source) and the dashboard propagates positions locally at 10 Hz, falling back to CelesTrak directly. |
| Flights | Poller snapshot, projected in the browser | OpenSky only allows its own site to read its API from a browser (CORS), so the poller fetches it every 30 min (4 of ~400 free daily credits per request) and the dashboard dead-reckons each aircraft along its track. Emergency squawks in zones also alert via Telegram. Flights are an auxiliary source: failures never trigger degraded notices. |
| SACHET (flood, heat, dam, cyclone) | Poller | Feeds send no CORS headers; a browser cannot read them. |
| River-rise and heat-wave signals | Poller | Needs batching, state and baselines. |
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

There is no public machine-readable feed of dam releases in India. CWC publishes **weekly** reservoir storage bulletins, not release events. Releases are announced by state water resources departments and district collectors, and only sometimes through SACHET.

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
4. **Delivery**: critical/high as individual messages; medium as one digest; hard cap of 8 messages per run.
5. **Labelling**: every message states *Official* or *Derived (not an official warning)* and links its source.

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
- **Dashboard**: Content Security Policy (scripts only from self and the pinned CDN) and Subresource Integrity hashes on every CDN script.

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
2. Split `src/app.js` into ES modules.
