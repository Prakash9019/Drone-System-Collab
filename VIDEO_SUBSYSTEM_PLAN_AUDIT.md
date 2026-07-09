# VIDEO_SUBSYSTEM_PLAN.md — Audit Report

Audited against: `/Users/suryprakash/Drone System Collab/qgroundcontrol` (live source, re-read line-by-line for every claim below — not taken from the plan's own citations).

---

## 1. Overall Assessment

**Honest estimate: ~78% faithful as an implementation spec. Not 98–100%.**

Reasoning:

- **Strategic architecture: excellent (~95%).** The manager/receiver/settings/camera-manager decomposition, the WebRTC-primary + WebCodecs-fallback transport choice, and the "port element knobs verbatim, replace the sink" strategy are all sound and correctly identify that a browser cannot literally replicate a same-process GStreamer→QVideoSink pipeline. This is not a flaw — it's the right call, and the plan is honest about it in §0.
- **Low-level GStreamer knobs (source elements, watchdog, tee+valve topology, codec priority/QoS trick): mostly accurate (~90%).** Verified against source: `tee`/`valve` topology is real (`GstVideoReceiver.cc:92,120,136,191,196`), `_watchdog()` line range is an *exact* match, `setCodecPriorities`/HW-detection/QoS-disable line numbers are *exact* matches. A handful of cited line ranges are off by tens of lines or point at the wrong file/element (see Gap Analysis #7, #8, #13).
- **Concrete, ship-blocking bugs exist in the "direct port" instructions (this is the main reason the score isn't higher).** The most serious: `subtitle_writer.py` is specified as writing `.srt` files with a hardcoded 6-field telemetry set. The real `SubtitleWriter.cc` writes `.ass` (Advanced SubStation Alpha) — a completely different format with positioning/styling syntax — and pulls a **dynamic, user-configured** set of Facts from the telemetry bar, not a fixed 6 fields. An engineer implementing the plan as written would ship a recording-overlay feature that doesn't resemble QGC's at all, despite the plan explicitly calling it a "direct port."
- **Settings coverage has real, silent gaps.** The plan's §2.5 port table carries 16 of QGC's 20 real `VideoSettings` facts. `showRecControl`, `forceCpuVideoPath`, `videoConversionElement`, and `disablePixelAspectRatio` are named in the narrative (§1, line 29) but never make it into the actual settings-port table or FastAPI spec — so they'd simply never get implemented.
- **One factual claim is simply wrong**: "`VIDEO_STREAM_INFORMATION` × N (one per stream_id 0..4)" — stream IDs are 1-based in QGC and the count is fully dynamic (`uint8_t`, no hardcoded cap of 5). Minor for a first cut, but would break with any camera advertising ≥5 streams or expecting 1-based IDs.
- **The plan's own line-number citations (§11, "reread before each step") are imprecise enough in ~5 places that a developer following them would land on the wrong function or the wrong file.** Since §11 is explicitly designed as a "go re-read this" pointer table, precision matters more there than elsewhere.

None of this invalidates the plan's overall shape — the architecture and 80% of the line-level detail hold up under direct source verification. But "98–100% production-ready replica" is not supportable; call it a strong first draft that needs the corrections in §3 before implementation starts, especially the SubtitleWriter section, which is currently a correctness bug, not a nice-to-have fix.

---

## 2. Gap Analysis Table

| # | Area | What QGC does (source) | What our plan says | Fix required |
|---|------|--------------------------|----------------------|----------------|
| 1 | **SubtitleWriter format** | Writes an **`.ass`** file (`SubtitleWriter.cc:54`: `"%1/%2.ass"`), full ASS `[Script Info]`/`[V4+ Styles]`/`[Events]` header (`SubtitleWriter.cc:71-87`) and `Dialogue:` lines with `{\pos(x,y)}`/`{\an3}` override tags (`SubtitleWriter.cc:137-138`) | §1 line 28 and §4.5 both say "SRT subtitles" / "open `<videoFile>.srt`" / "write an SRT block" | Rewrite `subtitle_writer.py` spec to emit `.ass` with the same header/`Dialogue:` structure, or explicitly document the deviation to SRT as an intentional simplification (losing positioned multi-column overlay layout) if SRT is chosen instead. See §3.1 below for the corrected spec. |
| 2 | **SubtitleWriter telemetry fields** | Dynamically reads whatever Facts are configured in the user's Telemetry Bar (`FactValueGrid`/`telemetryBarSettingsGroup`, `SubtitleWriter.cc:36-48`), formatted via `fact->cookedValueString()`/`cookedUnits()`/`shortDescription()` (`SubtitleWriter.cc:114-117`) — no field is hardcoded | §4.5: "write an SRT block with `lat, lon, alt, speed, heading, battery`" — a fixed, fabricated 6-field list | Make the recorded telemetry fields configurable (mirror whatever OSD/HUD fields the user has enabled), not hardcoded. At minimum, document that the 6-field list is a deliberate simplification, not a port. |
| 3 | **Stream ID range** | Stream IDs are **1-based** (`VehicleCameraControl.cc:1989-1991`: "Stream ID starts at 1"); count is dynamic from `VIDEO_STREAM_INFORMATION.count` (`uint8_t`, no hardcoded cap) | §1.8 says "VIDEO_STREAM_INFORMATION × N (one per stream_id 0..4)" implying 0-based, capped-at-5 | Correct `camera_manager.py` stream enumeration to start at `stream_id = 1` and iterate up to the advertised `count` (not a hardcoded range of 5). |
| 4 | **Missing settings facts** | 20 real `VideoSettings` facts exist (`VideoSettings.h:16-35`), including `showRecControl` (bool, default true), `forceCpuVideoPath` (bool), `videoConversionElement` (string), `disablePixelAspectRatio` (bool) | §2.5 port table has only 16 rows; these 4 are named in prose (§1 line 29) but never appear in the actual settings table, FastAPI schema, or `video_manager.py` spec | Add all 4 to §2.5's table with FE/BE keys and defaults (see §3.2 below). Decide explicitly whether `forceCpuVideoPath`/`videoConversionElement` are meaningful in a WebRTC-primary design (likely N/A, since decode is browser-side) and document that decision instead of silently dropping the facts. |
| 5 | **`videoSavePath` ownership** | Lives in `Video.SettingsGroup.json` but its real accessor is on **`AppSettings`**, not `VideoSettings` (`AppSettings.h:74,95`, `AppSettings.cc:293`) | Not mentioned; plan implies all facts are `VideoSettings`-scoped | Note this as a QGC quirk; no action needed for the port itself (our design already separates "save path" as an app-level concept), but worth a one-line comment so a future contributor doesn't go looking for it in the wrong module. |
| 6 | **`streamTimeout` fact** | No generic `streamTimeout` fact exists — only `rtspTimeout` (default 8s, `VideoSettings.h:27`), applied **only to RTSP sources**; non-RTSP sources get a hardcoded 3s connect timeout (`VideoManager.cc:839-842`) | §2.5 table has a single unified `streamTimeout`/`stream_timeout_s` (default 8) applied to all sources, conflating QGC's RTSP-specific vs. generic timeouts | Either keep the simplification and document it as an intentional deviation (a single unified timeout is arguably better UX), or split into `rtsp_connect_timeout_s` (8) and a separate generic connect timeout (3) to match QGC exactly. Recommend keeping the simplification but stating it explicitly rather than presenting it as a port. |
| 7 | **`_onBusMessage` scope** | Function handles `GST_MESSAGE_ERROR` (`1411-1446`), `WARNING` (`1447-1459`), `EOS` (`1460-1465`), `STREAM_COLLECTION` (`1466-1490`), `QOS` (`1491-1507`), **plus** `GST_MESSAGE_ELEMENT` (~1508-1529), `STATE_CHANGED` (~1530-1551), `LATENCY` (~1552+) — function extends well past line 1499 | §1.6 cites `GstVideoReceiver.cc:1401-1499` and lists only 5 of the ≥8 message types actually handled | Update the bus-message handler spec (`gst_video_receiver.py`) to also cover `STATE_CHANGED`-triggered latency queries and `LATENCY` messages if precise glass-to-glass latency reporting matters for the FE latency HUD. |
| 8 | **appsink property location** | `max-buffers=1`, `drop=TRUE`, `sync=FALSE`, `emit-signals=FALSE` are set on the **appsink itself**, inside `gstqgcvideosinkbin.cc` (GPU path: `361-368`; CPU path: `428-433`) — **not** in `GstVideoReceiver.cc`. `GstVideoReceiver.cc:1144-1146,1183-1184` sets `sync`/`max-lateness` on `_videoSink` (the wrapping bin), and `max-lateness=-1` is **never set on the appsink itself** anywhere | §1.5 attributes all 5 properties jointly to `GstVideoReceiver.cc:1144-1184` + `gstqgcvideosinkbin.cc:287-488` as if co-located | Correct the citation split when documenting `pipeline_factory.py`'s appsink-equivalent construction: `max-buffers/drop/sync/emit-signals` are appsink-level; `max-lateness` is bin-level and doesn't need a browser-side equivalent since WebRTC playout timing is fully delegated to the browser. |
| 9 | **Keyframe-probe location** | Probe *installation* is `GstVideoReceiver.cc:504-514`; the actual `_keyframeWatch` callback logic (drop-until-IDR + PTS offset reset) is a separate static method at `GstVideoReceiver.cc:1714-1730` | §1.2 cites a single range `GstVideoReceiver.cc:504-515` for "a keyframe probe" | Not a functional gap (the mechanism itself is correctly described), but `recorder.py`'s spec (§4.x) never explicitly calls out implementing this "drop non-keyframe buffers + reset PTS offset to 0 at first IDR" behavior — currently it's only mentioned narratively in §1.2, not turned into a concrete `recorder.py` requirement. Add it explicitly to §4.1/§4.2 recorder spec so it isn't lost between the architecture-notes section and the implementation-spec section. |
| 10 | **GStreamer init function name/range** | Real function is `VideoManager::startGStreamerInit()` (`VideoManager.cc:83-108`), a guarded state machine (`InitState::NotStarted→Pending→...`) using `.then()/.onCanceled()` continuations calling `_onGstInitComplete` (`VideoManager.cc:244-274`) | §1.7 describes it as an anonymous "runs once in `QtConcurrent::run` (`VideoManager.cc:83-100`)" with no state-machine detail | Minor citation fix only; functionally the plan's simplified description ("runs once") is directionally correct. No implementation change needed — `video_manager.py`'s init-guard (only run once) already matches the real guard behavior. |
| 11 | **Settings→restart flow indirection** | Real chain: Fact change → `_videoSourceChanged` (`521-556`) → `_updateSettings(receiver)` per-receiver (`667-720`) → if changed, `_restartAllVideos()` (`778-783`) → `_restartVideo(receiver)` (`785-800`) → `_stopReceiver` → **on `onStopComplete`, a `QTimer::singleShot(1000, ...)` delayed restart** (`VideoManager.cc:929-932`) → `_startReceiver`. Also: `lowLatencyMode` bypasses `_videoSourceChanged` entirely via a direct lambda (`VideoManager.cc:187`) | §1.9 collapses this into a 4-step flow and omits the **1-second delayed restart after stop** entirely | Add the 1s post-stop delay to `video_manager.py`'s restart logic — without it, our port would attempt to reopen the source socket/URI immediately after teardown, which can race with OS-level socket release on some platforms and cause spurious reconnect failures QGC doesn't have. |
| 12 | **`_updateSettings` scope** | Only checks `lowLatency`, then (non-thermal) `_updateUVC`, `_updateAutoStream`, and URI rebuild (`VideoManager.cc:676-717`) — does **not** check decoder or aspect-ratio changes; those have separate signal paths | §1.9 step 3 claims `_updateSettings` "returns true if URI/source/lowLatency/decoder/aspect changed" | No action needed for our port (our `video_manager.py` trigger-field list in §4.1 — `videoSource \| rtspUrl \| udpPort \| tcpUrl \| lowLatencyMode` — already happens to match the real trigger set, decoder/aspect correctly excluded). Just a documentation-accuracy note. |
| 13 | **GstAppSinkAdapter zero-copy class list** | Real class set: `GstDmaBufVideoBuffer`, `GstGlVideoBuffer`, `GstD3D11VideoBuffer`, **plus** `GstD3D12VideoBuffer`, `GstAHardwareBufferVideoBuffer` (Android), `GstIOSurfaceVideoBuffer` (macOS) — 6 total, all under `HwBuffers/` | §1.5/plan implies only 3 (DMABuf/GLMemory/D3D11/AHB — 4 named, 2 missing: D3D12, IOSurface) | Not applicable to our port (browser handles its own zero-copy decode path) — informational only, no action needed. Included here for completeness since it was an explicit audit target. |
| 14 | **Camera-info retry alternation not carried into spec detail** | `_requestCameraInfoHelper` alternates `MAV_CMD_REQUEST_MESSAGE`/`MAV_CMD_REQUEST_CAMERA_INFORMATION` by even/odd retry count, with exponential backoff from retry 2 (`QGCCameraManager.cc:534-604`) — this exists because some firmware only implements one of the two commands | §2.6 `camera_manager.py` spec says only "triggers `MAV_CMD_REQUEST_MESSAGE(CAMERA_INFORMATION)` with retry/back-off" — doesn't mention the alternation | Add explicit even/odd alternation between the two request mechanisms to `camera_manager.py`'s retry logic — without it, cameras that only support the legacy `MAV_CMD_REQUEST_CAMERA_INFORMATION` command (older ArduPilot/PX4 firmware) will silently never respond. |
| 15 | **`streamChanged` → `_updateAutoStream` indirection** | Real chain has an extra hop: `QGCCameraManager::streamChanged` → `VideoManager::_videoSourceChanged` (`VideoManager.cc:747`) → `_updateSettings` → `_updateAutoStream` (`VideoManager.cc:687`) | §1.8 diagram shows `emit streamChanged → VideoManager._updateAutoStream` as a single direct hop | No functional gap for our port — `video_manager.py`'s `update_auto_stream()` already correctly triggers a restart. Documentation-only correction to §1.8's diagram. |

---

## 3. Corrected & Improved Plan Sections

### 3.1 Corrected §4.5 `subtitle_writer.py`

Replace the existing §4.5 text entirely:

> ### 4.5 `subtitle_writer.py`
>
> <!-- ADDED: original spec said "SRT" — verified against SubtitleWriter.cc:54,71-87,137-138 that QGC writes .ass (Advanced SubStation Alpha), a positioned/styled format, not SRT. Corrected below. -->
>
> Subscribe to the existing telemetry stream (`telemetry_pub.py`). On `recording_start`, open `<videoFile>.ass` (matches QGC's extension so downstream players/editors that already expect `.ass` sidecars work unchanged — VLC, mpv, and most NLEs auto-load an `.ass` file with the same basename as the video).
>
> Write an ASS header once at file-open, mirroring QGC's structure (`SubtitleWriter.cc:71-87`):
> ```
> [Script Info]
> Title: Drone GCS Subtitle Telemetry file
> ScriptType: v4.00+
> WrapStyle: 0
> ScaledBorderAndShadow: yes
> YCbCr Matrix: TV.601
> PlayResX: <video_width>
> PlayResY: <video_height>
>
> [V4+ Styles]
> Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
> Style: Default,Monospace,<scaled_font_size>,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,1,10,10,10,1
>
> [Events]
> Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
> ```
>
> <!-- ADDED: field list is now dynamic, not hardcoded, matching SubtitleWriter.cc:36-48's telemetry-bar-driven approach -->
> Every 1s (matches QGC's `_kSampleRate = 1`, `SubtitleWriter.h:32`), emit two `Dialogue:` lines per configured telemetry field — one positioned name label, one positioned value — using whatever fields are currently enabled in the user's OSD/telemetry-bar configuration (not a hardcoded 6-field set):
> ```
> Dialogue: 0,<start>,<end>,Default,,0,0,0,,{\an3\pos(x,y)}<field_label>:
> Dialogue: 0,<start>,<end>,Default,,0,0,0,,{\pos(x,y)}<field_value> <field_unit>
> ```
> Field source: reuse the same `osd_profiles.json`-driven field list already used for the live HUD overlay, so the recorded subtitle track always matches what the operator was actually looking at during the flight — this is a *closer* match to QGC's intent (which mirrors the live telemetry bar) than a fixed field list would be.
>
> Close the file on `recording_stop`.
>
> <!-- ADDED: explicit fallback note -->
> If `.ass` support in target video players is a concern, an `.srt`-emitting mode MAY be offered as a secondary/simplified export option — but it must be documented as a deliberate simplification (loses positioning/multi-column layout), not presented as matching QGC's behavior.

### 3.2 Corrected §2.5 Settings model — add missing facts

<!-- ADDED: 4 rows below were named in §1 prose but missing from this table; verified against VideoSettings.h:16-35 and Video.SettingsGroup.json -->

Append to the existing table in §2.5:

| Frontend store key | Backend key | Type / values | Default | Notes |
|---|---|---|---|---|
| `showRecControl` | `show_rec_control` | bool | `true` | <!-- ADDED --> QGC: `VideoSettings.h:23`. Controls whether the record button/UI is shown at all; port as a UI-visibility toggle in `VideoSettingsPanel.jsx`. |
| `forceCpuVideoPath` | `force_cpu_video_path` | bool | `false` | <!-- ADDED --> QGC: `VideoSettings.h:32`. **Likely N/A for our architecture** — decode happens in the browser (WebRTC) or is passthrough (WebCodecs); there is no backend GPU/CPU decode path to force. Document as intentionally unimplemented rather than silently dropped. |
| `videoConversionElement` | `video_conversion_element` | string | `""` | <!-- ADDED --> QGC: `VideoSettings.h:33`. Same as above — backend never converts pixel formats since it doesn't decode. N/A, document explicitly. |
| `disablePixelAspectRatio` | `disable_pixel_aspect_ratio` | bool | `false` | <!-- ADDED --> QGC: `VideoSettings.h:34`. **This one DOES matter** for us — non-square-pixel sources (e.g. some analog-to-digital converters) need PAR correction before `object-fit` sizing is correct in the `<video>` element. Wire this into `VideoView.jsx`'s aspect-ratio calculation (§2.4), not just the backend. |

### 3.3 Corrected §2.6 `camera_manager.py` retry logic

Replace this paragraph in §2.6:

> - `camera_manager.py` — listens on the existing MAVLink mux (`mavlink_link.py`), on HEARTBEAT with `compid ∈ {MAV_COMP_ID_CAMERA..CAMERA6}` triggers `MAV_CMD_REQUEST_MESSAGE(CAMERA_INFORMATION)` with retry/back-off.

with:

> - `camera_manager.py` — listens on the existing MAVLink mux (`mavlink_link.py`), on HEARTBEAT with `compid ∈ {MAV_COMP_ID_CAMERA..CAMERA6}` (100–105) triggers a `CAMERA_INFORMATION` request. <!-- ADDED: alternation logic, verified against QGCCameraManager.cc:534-604 --> **Alternate the request mechanism by retry count**: even retries send `MAV_CMD_REQUEST_MESSAGE(CAMERA_INFORMATION)`; odd retries send the legacy `MAV_CMD_REQUEST_CAMERA_INFORMATION` command — some firmware (older ArduPilot/PX4) only implements one of the two. Apply exponential backoff starting from the 2nd retry, matching QGC's behavior.

And correct stream enumeration in the same section:

> - Request `VIDEO_STREAM_INFORMATION` for each declared stream → assemble list keyed by `stream_id`.

becomes:

> - Request `VIDEO_STREAM_INFORMATION` for each declared stream. <!-- ADDED: corrected from "stream_id 0..4", verified against VehicleCameraControl.cc:1989-1991 and 1672-1712 --> **Stream IDs are 1-based** (`stream_id = 1..count`), and `count` is a dynamic `uint8_t` field from `VIDEO_STREAM_INFORMATION` with no hardcoded cap — do not assume a max of 5 streams. Wait (poll every 1s, mirroring QGC's `_streamInfoTimer`) until the number of received stream-info messages matches the advertised `count` before considering camera discovery complete.

### 3.4 Corrected §4.1 `video_manager.py` restart flow

Append to the responsibilities list in §4.1:

> - <!-- ADDED: verified against VideoManager.cc:929-932 — QGC inserts a 1s delay between stop-complete and restart -->  On receiver stop-complete (from a triggered restart), wait **1 second** before calling `start()` again, matching QGC's `QTimer::singleShot(1000, ...)` delay. This avoids racing the OS on socket/port release, particularly for UDP sources being rebound immediately after teardown.

---

## 4. What Is Correctly Captured

- **The core strategic call — WebRTC primary + WebCodecs fallback, backend GStreamer terminates only source-protocol handling and never transcodes on the primary path — is well-reasoned and doesn't need correction.** It correctly identifies that QGC's same-process pipeline can't be replicated in a browser and picks the closest practical analog.
- **`tee` + `valve` decode/record branch topology is real and accurately described** (`GstVideoReceiver.cc:92,120,136,191,196` — confirmed by the file's own header comment).
- **Source-element selection table (§1.3) is accurate**: `rtspsrc`/`udpsrc`+RTP-caps/`tcpclientsrc`+`tsdemux`/`udpsrc`+`tsdemux` for the four protocols, with the correct property knobs (`latency=25`, `do-rtcp=TRUE`, `tcp-timeout=5s`, `udp-reconnect=TRUE`, `retry=3` on `rtspsrc`).
- **The keyframe-defer-before-record mechanism (drop non-keyframe buffers, reset PTS offset at first IDR) is correctly identified**, even though its exact line split needed a citation fix (Gap #9).
- **`setCodecPriorities`, HW-decoder-detection, and the QoS-disable frame-drop-cascade fix are all cited with exact, verified line numbers** (`GStreamerHelpers.cc:203-260`, `:40-96`; `GstVideoReceiver.cc:1051-1056`) — genuinely precise research, not guesswork.
- **`_watchdog()` line range (`576-609`) and the 2× decoder-timeout multiplier are exact matches.**
- **appsink property values themselves (`max-buffers=1, drop=TRUE, sync=FALSE, emit-signals=FALSE`) are correct**, even though the plan slightly misattributes which file/line sets them (Gap #8).
- **MAVLink camera handshake diagram (§1.8) is structurally accurate**: HEARTBEAT → `_handleHeartbeat` → `CAMERA_INFORMATION` request/response → `VIDEO_STREAM_INFORMATION` × N → `_streamInfoTimer` wait-for-count → `streamChanged` → auto-stream update → restart. Every named function (`_handleHeartbeat`, `_handleCameraInfo`, `handleVideoStreamInformation`) is real, and `VehicleCameraControl::handleVideoStreamInformation`'s cited line range (`1672-1712`) is an **exact match**.
- **Recording muxer/faststart handling (`mp4mux faststart=TRUE`) matches QGC's real crash-safety approach.**
- **§9 performance analysis (no-transcode-on-backend, freeing CPU for telemetry) is a genuinely good architectural insight** that goes beyond what QGC itself needs to worry about (QGC is a single desktop process; our split backend/frontend has different constraints, and the plan reasons about this correctly).
- **§7 latency budget and §8 stability/recovery tables are reasonable, appropriately scoped translations** of QGC's watchdog/reconnect philosophy into a WebRTC-based world (ICE state monitoring standing in for GStreamer bus-error handling).
- **§12 "Out of Scope" section correctly excludes vendor-specific presets, UVC, thermal blending modes, and camera gimbal control** — consistent with what was found in source (vendor presets are just named URIs, not separate code paths; confirmed independently in the prior video-architecture research task).

---

## 5. Final Checklist — Production Readiness

| Subsystem | Ready as currently specified? |
|---|---|
| Core pipeline architecture (source → tee/valve → decode/record split, adapted to WebRTC) | **Yes** — verified sound against real `GstVideoReceiver.cc` topology |
| Source-protocol handling (RTSP/UDP-RTP/TCP-MPEGTS/UDP-MPEGTS + element knobs) | **Yes** — knobs verified accurate |
| Watchdog / timeout / reconnect logic | **Mostly** — needs the 1s post-stop restart delay added (Gap #11) |
| Recording (muxer, faststart, keyframe-gated record branch) | **Mostly** — keyframe-probe behavior needs to move from architecture-notes into an explicit `recorder.py` requirement (Gap #9) |
| Telemetry-in-recording (SubtitleWriter port) | **No** — currently specifies the wrong file format (SRT vs real `.ass`) and a fabricated fixed field list; must be corrected before implementation (Gap #1, #2 / fix in §3.1) |
| Settings/Facts coverage | **No** — 4 real facts (`showRecControl`, `forceCpuVideoPath`, `videoConversionElement`, `disablePixelAspectRatio`) are missing from the implementation table (Gap #4 / fix in §3.2) |
| MAVLink camera discovery handshake | **Mostly** — needs the request-alternation retry logic and 1-based/dynamic stream-ID handling added (Gap #3, #14 / fixes in §3.3) |
| WebRTC transport + frontend rendering | **Yes** — no source-verification issues found in this layer (it has no direct QGC analog to audit against, by design) |
| Bandwidth/QoS handling | **Yes, matches QGC's actual (lack of) sophistication** — QGC itself has no cross-link QoS arbitration between video/telemetry (confirmed in prior research task), so the plan's equivalent scope is appropriately matched, not a gap |
| Line-number citations for future implementers (§11 reread table) | **No** — ~5 of the citations are imprecise enough to send a developer to the wrong function; recommend updating §11 with the corrected ranges from §2 of this audit before development starts |

**Bottom line:** ship-block on the SubtitleWriter section and the missing-facts table before implementation begins; everything else is either already correct or a minor citation/precision fix that doesn't change behavior.
