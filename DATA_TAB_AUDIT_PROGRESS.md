# DATA TAB — AUDIT PROGRESS TABLE

Implementation update for the gaps identified in [`DATA_TAB_AUDIT_TABLE.md`](./DATA_TAB_AUDIT_TABLE.md).
Source-of-truth audit is unchanged. This file tracks **only** what was *Missing / Partial / Fragmented / Duplicate* and what was just shipped.

Columns:
- **Feature** — short identifier (matches IDs in `DATA_TAB_AUDIT_TABLE.md` where applicable)
- **Fixed** — what landed this round (production code, no scaffolding)
- **Remaining** — what is still open after this round
- **Files changed**

---

## ✅ PRIORITY 1 — HUD missing widgets

| Audit ID | Feature | Fixed | Remaining | Files changed |
| --- | --- | --- | --- | --- |
| H14 | Distance-to-home (HUD widget) | Added — haversine from `position` vs `home`, formatted m / km, rendered in new top-right info column | none | `drone_gcs/frontend/src/components/AdvancedHUD.jsx`, `drone_gcs/frontend/src/pages/FlightData.jsx` |
| H15 | Distance-to-next-WP (HUD widget) | Surfaced `navigation.wp_dist` (NAV_CONTROLLER_OUTPUT) in HUD info column; sentinel −1 treated as "no value" | none | `drone_gcs/frontend/src/components/AdvancedHUD.jsx` |
| H16 | Mission progress / current WP (HUD widget) | Rendered `WP (current+1)/total` in HUD using `mission.current_seq` + `useMissionStore.missionPlannedTotal` (with `_missionSaved` / `waypoints` fallbacks) | none | `drone_gcs/frontend/src/components/AdvancedHUD.jsx`, `drone_gcs/frontend/src/pages/FlightData.jsx` |
| H18 | Flight / pre-arm warnings overlay | New PREARM overlay derived from `SYS_STATUS` `sensors_present & sensors_enabled & ~sensors_health`; lists top 4 failing sensor names (Gyro/Accel/Mag/GPS/RC/PreArm/…); only visible while disarmed | per-failure severity colours by sensor class | `drone_gcs/frontend/src/components/AdvancedHUD.jsx` |
| H19 | STATUSTEXT overlays on HUD | New `<StatusTextToast>` — bottom-of-HUD slide; severity-coloured (EMERG/ALERT/CRIT/ERROR red→orange→amber); 6 s lifetime; dedup on `(timestamp, text)`; sev ≤ 4 only | none | `drone_gcs/frontend/src/components/AdvancedHUD.jsx` |
| H21 | HUD-bound flight-path trail | **Deferred** — map trail already exists; HUD overlay was not part of P1 ask | optional follow-up | — |
| H31 | HUD uses centralised telemetry selectors | unchanged — current inlined math is correct and not failing; selector migration would be churn for no behaviour change | optional migration | — |

---

## ✅ PRIORITY 2 — Parameter system UX

| Audit ID | Feature | Fixed | Remaining | Files changed |
| --- | --- | --- | --- | --- |
| P11 | Parameter metadata displayed in UI | Added range row (`min..max` + `step`) and enum-value label (e.g. FENCE_ACTION = "RTL or Land") under each row in `Params.jsx` | per-param wiki link | `drone_gcs/frontend/src/pages/Params.jsx` |
| P13 | Dirty / unsaved-changes UI indicator | Dirty-row chip (●), aggregate "Save All (N)" + "Revert" toolbar buttons, dirty count drives button-enable | per-row revert button | `drone_gcs/frontend/src/pages/Params.jsx` |
| (new) | Per-row save lifecycle (ACK / error surfacing) | Per-key `saveStatus` state — Save button flips to "…" / "OK" / "ERR" with hover-tooltip showing error text or save time | retry button on ERR | `drone_gcs/frontend/src/pages/Params.jsx` |
| (new) | Parameter validation (range check) | Out-of-range edits highlight red and disable Save until valid; pulls min/max from metadata; `<input>` gets native min/max/step attrs | floor/ceil clamp toggle | `drone_gcs/frontend/src/pages/Params.jsx` |
| (new) | Range/enum metadata richness | Extended `param_metadata_common.json` with min/max/increment for ATC_RAT_*, WPNAV_*, RTL_*, FENCE_*, BATT_CAPACITY/MONITOR; values{} enum for FENCE_ENABLE/FENCE_ACTION | extend coverage across remaining ArduPilot/PX4 params | `drone_gcs/python_service/param_metadata_common.json` |

---

## ✅ PRIORITY 3 — Connection diagnostics

| Audit ID | Feature | Fixed | Remaining | Files changed |
| --- | --- | --- | --- | --- |
| C12 (extend) | Exponential backoff | New `_next_backoff_delay()`: `base · 2^(attempts−1)` capped at 30 s; replaces fixed 1 s retry. `_reconnect_attempts` increments per attempt and resets on CONNECTED | jitter | `drone_gcs/python_service/mavlink_link.py` |
| C13 | Exponential backoff (missing flag) | Done as above | none | `drone_gcs/python_service/mavlink_link.py` |
| C14 | Max-reconnect-attempt cap | `reconnect_max_attempts` (default 0 = unlimited, matching MP); transitions to DISCONNECTED with `reason="max_attempts_reached"` when exceeded | UI to set cap | `drone_gcs/python_service/mavlink_link.py` |
| C15 | Connect-failure reason codes | Structured codes: `auto_detect_failed`, `transport_error`, `no_heartbeat`, `handshake_timeout`, `max_attempts_reached`, `user_disconnect`. Carried on every `_set_connection_state(reason=…, detail=…)` and stored in `last_error_reason` / `last_error_detail` | reason codes per transport (BLE / USB-unplug) | `drone_gcs/python_service/mavlink_link.py` |
| (new) | State-transition history | Rolling 20-entry `_state_history` with `{from, to, reason, detail, at}` | history viewer | `drone_gcs/python_service/mavlink_link.py` |
| (new) | `/connection/status` diagnostics block | New `connection_diagnostics()` snapshot returned by both `/connection/status` and `/connection/start`. Mirrored through `node_api/server.js` (no shape change). Frontend store gains `connectionDiagnostics` + `pollConnectionStatus()` polled at 1.5 s while not CONNECTED | none | `drone_gcs/python_service/mavlink_link.py`, `drone_gcs/python_service/main.py`, `drone_gcs/frontend/src/store/useTelemetryStore.js`, `drone_gcs/frontend/src/pages/FlightData.jsx` |
| (new) | Reconnect diagnostics ribbon | New status row beneath the connection ribbon — only shown when not CONNECTED + diagnostics exist. Shows reason, detail, attempts, next-retry ETA, current backoff | colour-by-reason styling | `drone_gcs/frontend/src/pages/FlightData.jsx` |

---

## ✅ PRIORITY 4 — Replay UI

| Audit ID | Feature | Fixed | Remaining | Files changed |
| --- | --- | --- | --- | --- |
| T15 / M7 | Replay UI (record / play / pause / resume / stop / seek) | New `ReplayTab.jsx` plugged into `TelemetryGrid`. Talks only to Node gateway. Surfaces `replayStatus` (already published over WS). Sessions list polled every 5 s. Recording toggle, playback transport controls, scrub slider, progress bar, formatted m:ss times | session delete / rename, playback speed slider | `drone_gcs/frontend/src/components/tabs/ReplayTab.jsx`, `drone_gcs/frontend/src/components/TelemetryGrid.jsx` |
| (new) | Node API replay passthroughs | Added 7 routes (`/api/replay/record/{start,stop}`, `/api/replay/sessions`, `/api/replay/playback/{start,stop,pause,resume,seek}`) — verbatim forwarders to Python `/replay/*` (which was already implemented) | none | `drone_gcs/node_api/server.js` |

---

## ✅ PRIORITY 5 — Map dedup

| Audit ID | Feature | Fixed | Remaining | Files changed |
| --- | --- | --- | --- | --- |
| D1 | Fence polygon grouping duplicated × 3 | Extracted `buildFenceGroups(vertices)` into new `utils/mapShared.js`. `MapView` and `MapEditor` both import from there. `FlightPlanner.buildFencePolygonGroups` left intact — different return shape (validation-focused, retains full WP objects) | optionally fold `FlightPlanner` variant onto the shared core with a `{shape: 'render' \| 'validate'}` flag | `drone_gcs/frontend/src/utils/mapShared.js`, `drone_gcs/frontend/src/components/MapView.jsx`, `drone_gcs/frontend/src/components/MapEditor.jsx` |
| D2 | Drone heading derivation × 3 | Extracted `deriveHeadingDeg(vehicle)` → single source. `MapView` keeps a thin local alias `headingDegFromVehicle` for call-site stability. `MapEditor.vehicleMapState` simplified. `mapSelectors.js` left as is (it imports nothing yet from mapShared — separate concern) | optionally migrate `mapSelectors.deriveHeading` onto shared | `drone_gcs/frontend/src/utils/mapShared.js`, `drone_gcs/frontend/src/components/MapView.jsx`, `drone_gcs/frontend/src/components/MapEditor.jsx` |
| D3 | Home marker render × 2 | Extracted `createHomeMarker(map, home)` + `isValidHome(home)`. Both `MapView` and `MapEditor` now use the same green-house SVG. Removed inline SVG strings | none | `drone_gcs/frontend/src/utils/mapShared.js`, `drone_gcs/frontend/src/components/MapView.jsx`, `drone_gcs/frontend/src/components/MapEditor.jsx` |
| (new) | Waypoint marker colour map | Lifted `markerColor()` into `mapShared.waypointMarkerColor`. `MapEditor` imports it (aliased back to `markerColor` so existing call site is unchanged). `MapView` keeps its inline colour switch — it's locked to "active green vs takeoff amber vs land/RTL red vs blue" for the live view and intentionally simpler | optionally migrate MapView render to shared | `drone_gcs/frontend/src/utils/mapShared.js`, `drone_gcs/frontend/src/components/MapEditor.jsx` |

---

## What was NOT touched (already production-ready per audit)

Confirmed untouched, in line with the "DO NOT TOUCH" list:

- ARM, FORCE ARM, DISARM, TAKEOFF, LAND, RTL, MISSION_START, PAUSE, CONTINUE shortcuts
- All `node_api/server.js` `COMMAND_SHORTCUTS` rows (lines 210–220)
- Generic mode switching (`/api/mode` → `set_mode`)
- Fly-to-here / DO_REPOSITION (`/api/flyto`)
- Set HOME, ROI, ROI clear
- Mission overlays (route line, seq labels, active-WP highlight) — only the *grouping helper* was extracted; rendering paths unchanged
- Geofence overlay rendering (inclusion / exclusion polygons, dashed outline)
- Rally point overlay
- ADS-B overlay
- Flight path trail (map)
- Auto-follow, first-fix-centre, "Go to vehicle"
- MAVLink ingest (all 16+ message types, all handlers in `message_handlers.py`)
- ZMQ PUB → Node engine → WS bridge
- All 6 telemetry/parameter/mission/preflight/command/map selectors
- Parameter cache + JSON/.param import/export/diff/reset
- Connection state machine core (DISCONNECTED → CONNECTING → WAITING_FOR_HEARTBEAT → CONNECTED → HEARTBEAT_LOST → RECONNECTING) — only annotated with reason codes
- SITL auto-connect

No regressions introduced: existing behavioural paths only gained additional information (reason codes, diagnostics), and shared helpers were extracted with identical logic.

---

## Roll-up vs original audit table

| Section | Was | Now |
| --- | --- | --- |
| HUD missing widgets (H14–H19) | 5 missing | 0 missing (H21 deferred — map already covers trail) |
| Parameter UX (P11, P13, + new) | 3 missing/partial | 0 (metadata UI rich, dirty + per-row save state, validation) |
| Connection diagnostics (C13–C15) | 3 missing + 1 partial | 0 missing (cap, backoff, reason codes, history, UI) |
| Replay UI (T15) | 1 missing | 0 (full transport UI + Node proxies) |
| Map dedup (D1–D3) | 3 duplicates | 0 (single shared module; FlightPlanner validate-shape variant intentionally kept) |

**Remaining open items** (all originally classified as separate gaps, not in this implementation window):

- M6 — configurable telemetry stream rates from UI
- M8 — emergency stop / kill switch
- M9 — per-mode validation (AUTO needs mission, GUIDED needs position) is partially in `FlightData.applyFlightMode` for AUTO; not extended to GUIDED / other modes
- M11 — saved connection profiles
- M14 — tile-provider switcher
- M15 — distance / bearing measurement tool
- M16 — altitude profile along path
- M17 — UDP-server / forwarding UI

These were out of scope for the prioritised P1–P5 sweep.
