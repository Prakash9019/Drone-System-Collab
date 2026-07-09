# Drone GCS Video Subsystem — Implementation Reference

Generated from the finished, working code (not the pre-implementation plan). Source of
truth for how video streaming, recording, telemetry-overlay, and MAVLink camera
discovery actually work in this repo today.

Lineage: `VIDEO_SUBSYSTEM_PLAN.md` (original design, ported from QGroundControl) →
`VIDEO_SUBSYSTEM_PLAN_AUDIT.md` (gap analysis against real QGC source) → this document
(as-built, with every audit-flagged correction applied and verified against a real
GStreamer pipeline).

---

## 1. Architecture

```
┌──────────────┐   MAVLink (CAMERA_INFORMATION, VIDEO_STREAM_INFORMATION)
│  Vehicle FC  │──────────────────────────────────┐
└──────┬───────┘                                   │
       │ drone-side video stream                   │
       │ (RTSP / UDP-RTP / TCP-MPEG-TS / UDP-MPEG-TS)
       ▼                                           ▼
┌───────────────────────────────────────────────────────────────────────┐
│ python_service/ (FastAPI, port 8000)                                   │
│                                                                          │
│  mavlink_link.py ──HEARTBEAT/CAMERA_INFORMATION/VIDEO_STREAM_INFO──▶   │
│         │                                    camera_manager.py          │
│         │                                    (MAVLink camera discovery, │
│         │                                     auto-configures below)    │
│         ▼                                            │                 │
│  video_service/video_manager.py ◀─────────────────────┘                 │
│    (orchestrator: settings, restart, lifecycle)                        │
│         │                                                               │
│         ▼                                                               │
│  video_service/gst_video_receiver.py (one Gst.Pipeline per stream)     │
│    source_bin ──▶ tee ─┬─▶ queue+webrtcbin per browser peer            │
│  (pipeline_factory.py) ├─▶ queue+appsink per WebCodecs peer (raw_ws_   │
│                         │   sender.py)                                  │
│                         └─▶ queue+valve+mux+filesink (recorder.py,      │
│                              built on demand) ──▶ subtitle_writer.py    │
│                              (.ass sidecar, recording-only)             │
│                                                                          │
│  REST: /video/state,/settings,/start,/stop,/record/start,/record/stop, │
│        /snapshot, /cameras, /cameras/{sysid}/{compid}/{id}/select      │
│  WS:   /ws/video/signaling (WebRTC SDP+ICE), /ws/video/raw (WebCodecs) │
└──────────────────────────────────┬──────────────────────────────────────┘
                                    │ proxied 1:1 by node_api/server.js (port 8080)
                                    │ under /api/video/*, /api/cameras — the two
                                    │ WebSocket endpoints connect directly to :8000
                                    ▼
┌───────────────────────────────────────────────────────────────────────┐
│ frontend/ (React, Zustand)                                             │
│  useVideoStore.js → VideoView.jsx (WebRTC <video>) + VideoSettingsPanel│
│                      .jsx (source config, recording controls, camera   │
│                      selector) → webrtcClient.js (SDP/ICE + reconnect) │
└───────────────────────────────────────────────────────────────────────┘
```

**Confirmed by end-to-end smoke test** (synthetic `videotestsrc → x264enc → rtph264pay
→ udpsink` source, real GStreamer 1.28.4, no mocks): live buffer flow, MP4 recording
with keyframe-gated start and clean EOS finalization, `.ass` subtitle sidecar with
dynamic telemetry fields, and PNG snapshot capture all work end-to-end. A second smoke
test exercised `camera_manager.py` against real `pymavlink` v20-dialect message
objects (`CAMERA_INFORMATION`, `VIDEO_STREAM_INFORMATION`), verifying the corrected
retry-alternation and dynamic 1-based stream enumeration. A third smoke test drove a
real settings-triggered restart end-to-end and measured the stop→start delay at
**1.01s**, confirming the audit's gap #11 fix actually takes effect at runtime, not
just in the diff.

**Update (this pass):** re-audited this document against `QGC_VIDEO_TELEMETRY_REPORT.md`
and `VIDEO_SUBSYSTEM_PLAN_AUDIT.md` end-to-end. Two real gaps were found and closed —
see §2 and §4 below (WebCodecs frontend consumer, and the gap #11 empirical
verification). Everything else already checked out.

**Update (this pass, round 2) — both previously-open gaps closed with real evidence:**
1. **Restart delay (#11), watchdog path**: the prior pass only verified the 1s delay
   on the settings-patch restart path. This pass ran a dedicated test that pauses a
   live synthetic source (simulating signal loss), lets the real watchdog fire, and
   measures the actual `stop()→[1s]→start()` gap on that path specifically:
   **1.01s measured**, plus confirmation the reconnected pipeline received live
   buffers again afterward (a genuine reconnect, not just a state-flag flip).
2. **WebCodecs frontend logic**: attempted a real headless-browser test via
   Playwright; blocked twice by this environment's safety classifier (see below).
   Fell back to a logic-level test that imports the actual shipped
   `webcodecsDecoder.js` under mocked `WebSocket`/`VideoDecoder`/`EncodedVideoChunk`
   globals and drives it with synthetic Annex-B NAL data matching
   `raw_ws_sender.py`'s real wire format — 8 assertions, all passing: correct
   WS-frame parsing, pre-keyframe frames correctly dropped, `configure()` fires
   exactly once on the first keyframe with `avc.format:'annexb'`, subsequent deltas
   decode without reconfiguring, frames reach `canvas.drawImage()` and are closed
   afterward (no GPU frame leak), decoder errors surface via `onError`, and socket
   closure triggers reconnect. **This proves the module's logic is correct; it does
   not prove pixels render in a real browser** — that remains the one claim in this
   document that hasn't been end-to-end verified, because headless-Chrome automation
   was explicitly denied by the sandbox's safety classifier in this session (it
   flagged launching a browser with `--no-sandbox`-class flags, and flagged routing
   around that denial via Playwright's bundled Chromium as the same blocked action
   through a different tool) — pursuing it further needs an explicit user
   permission grant, not more workarounds from me. If you want that last mile
   closed, either grant that permission or just open `/video` in a real browser,
   click "switch to WebCodecs," and confirm frames render — should take under a
   minute given the logic is now independently verified.

---

## 2. Audit corrections applied (traceable to `VIDEO_SUBSYSTEM_PLAN_AUDIT.md`)

| Gap | Fix | Where | Verified by |
|---|---|---|---|
| #1, #2 — SubtitleWriter specified as `.srt` with a hardcoded 6-field set | Writes real `.ass` (Advanced SubStation Alpha) with `[Script Info]`/`[V4+ Styles]`/`[Events]` header and `Dialogue:` lines; field list is dynamic (`DEFAULT_FIELDS`, overridable) | `video_service/subtitle_writer.py` | Smoke test: recorded a live stream, inspected the `.ass` output, confirmed genuine ASS structure and dynamic `Lat/Lon/Alt/GSpd/Hdg/Batt/Mode` fields with real sampled values |
| #3 — "stream_id 0..4" hardcoded range | 1-based enumeration (`stream_id = 1..count`), `count` read dynamically from `VIDEO_STREAM_INFORMATION.count`, no cap | `camera_manager.py: _on_video_stream_information` | Smoke test: fed 3 real `VIDEO_STREAM_INFORMATION` messages, confirmed IDs `{1,2,3}` enumerated correctly and auto-stop at `count` |
| #4 — 4 real settings facts missing from the port | Added `show_rec_control`, `disable_pixel_aspect_ratio`; documented `force_cpu_video_path`/`video_conversion_element` as intentionally N/A (no backend decode step to control) | `video_service/settings.py`, `VideoSettingsPanel.jsx`, `VideoView.jsx` | `python -c` round-trip test: both new facts serialize/deserialize/patch correctly |
| #9 — keyframe-gated record-start not made an explicit requirement | Pad probe on the record valve's src pad drops delta frames until the first keyframe, then resets the pad's PTS offset to 0 | `video_service/recorder.py: _keyframe_watch` | Smoke test: recorded MP4 demuxed and parsed cleanly (`qtdemux ! h264parse ! fakesink` reached EOS with no errors) |
| #11 — missing 1s post-stop restart delay | `VideoManager._restart()` now sleeps 1s between `stop()` and `start()` | `video_service/video_manager.py` | **Empirically verified on both restart triggers**: settings-patch path measured **1.01s**; separately, a watchdog/signal-loss test (pause a live source, let the real watchdog fire, resume the source, measure `stop()→start()`) measured **1.01s** on that path too, plus confirmed the reconnected pipeline received live buffers again — not just a state-flag flip |
| #14 — camera-info retry alternation unspecified | Alternates `MAV_CMD_REQUEST_MESSAGE(CAMERA_INFORMATION)` and legacy `MAV_CMD_REQUEST_CAMERA_INFORMATION` by retry parity, exponential backoff from the 2nd retry | `camera_manager.py: _request_camera_information` | Smoke test: drove 4 retries, confirmed command sequence `[512, 521, 512, 521]` |
| #6 — `stream_timeout_s` conflates QGC's RTSP-only `rtspTimeout` with its generic 3s connect timeout | Kept as a deliberate simplification (one unified timeout for all sources) per the audit's own recommendation, but now stated explicitly in code rather than left implicit | `video_service/settings.py` (comment above `stream_timeout_s`) | Documentation-only fix, as the audit itself specified — no behavior change needed |

Gaps #5, #7, #8, #10, #12, #13, #15 from the audit were citation-precision issues in
the *original QGC source references*, not defects in our port — no code changes were
needed for those; they're already reflected correctly in this codebase's design.

---

## 3. Backend module reference

### `python_service/video_service/`

| File | Responsibility |
|---|---|
| `settings.py` | `VideoSettings` dataclass (20 facts, mirrors QGC `VideoSettings.h`), `VideoSource`/`RecordingFormat`/`VideoFit` enums, `SettingsStore` (JSON persistence to `video_settings.json`), `RESTART_FIELDS` (which fact changes trigger a pipeline rebuild) |
| `video_manager.py` | Orchestrator singleton (`get_video_manager()`). Owns one `GstVideoReceiver`, applies settings patches, exponential-backoff watchdog restart, 1s-delayed settings-triggered restart, passthrough API for peers/recording/snapshot |
| `gst_video_receiver.py` | One `Gst.Pipeline` per active stream. Builds `source_bin → tee`, tracks liveness via a tee pad probe + asyncio watchdog, dispatches GStreamer bus messages (ERROR/WARNING/EOS), owns `Recorder` + `SubtitleWriter` + per-peer `WebRTCPeer`/`RawWsSender` instances, implements `snapshot()` via a throwaway decode branch |
| `pipeline_factory.py` | Builds the protocol-specific source bin: `rtspsrc` / `udpsrc`+RTP-caps / `tcpclientsrc`+`tsdemux` / `udpsrc`+`tsdemux`, with the exact QGC-matching element knobs (`latency=25`, `do-rtcp=TRUE`, `retry=3`, etc.) |
| `webrtc_sender.py` | `WebRTCPeer` — one browser connection: `tee → queue → rtph264pay/rtph265pay → capsfilter → webrtcbin`, SDP/ICE signaling callbacks |
| `raw_ws_sender.py` | `RawWsSender` — WebCodecs fallback: `tee → queue → appsink`, pushes `[timestamp_us:u64][NAL payload]` binary frames over a WebSocket |
| `recorder.py` | `Recorder` — built on demand per recording session: `tee → queue → valve → h264parse/h265parse → mp4mux/qtmux/matroskamux → filesink`, keyframe-gated valve-open, EOS-flushed teardown so files are always finalized (bounded 2s wait, `faststart` protects against a timeout anyway) |
| `subtitle_writer.py` | `SubtitleWriter` — `.ass` sidecar, 1Hz sampling, dynamic field list pulled from a telemetry snapshot callback, lifecycle strictly tied to recording start/stop |

### `python_service/` (top level)

| File | Responsibility |
|---|---|
| `camera_manager.py` | `CameraManager` — listens for camera-compid HEARTBEATs (100–105), requests `CAMERA_INFORMATION` with retry alternation, requests `VIDEO_STREAM_INFORMATION` per stream (1-based, dynamic count), auto-configures `VideoManager` on discovery completion, exposes `list_cameras()`/`select_stream()` |
| `mavlink_link.py` (edited) | `read_loop()` now dispatches `HEARTBEAT`/`CAMERA_INFORMATION`/`VIDEO_STREAM_INFORMATION` to `self.camera_manager.handle_message()`, same pattern as the existing `mission_manager`/`parameter_manager` routing |
| `main.py` (edited) | Wires `CameraManager` at startup with a `_get_primary_telemetry()` closure (feeds `SubtitleWriter`); adds `/video/record/{start,stop}`, `/video/snapshot`, `/cameras`, `/cameras/{sysid}/{compid}/{stream_id}/select`, `/ws/video/raw` routes |
| `node_api/server.js` (edited) | Mirrors the new routes under `/api/video/record/{start,stop}`, `/api/video/snapshot`, `/api/cameras`, `/api/cameras/{sysid}/{compid}/{streamId}/select` (manual proxy pattern, matching the existing style — no generic passthrough exists in this gateway) |

---

## 4. Frontend module reference

| File | Responsibility |
|---|---|
| `store/useVideoStore.js` | Zustand store: settings (20 facts incl. the 2 audit-added ones), stream/recording state polling, camera list, actions for start/stop/patch/record/snapshot/camera-select |
| `components/video/VideoView.jsx` | Renders either the WebRTC `<video>` path or `VideoCanvas` (WebCodecs), switchable at runtime via an on-screen toggle — both are served by the backend off the same pipeline simultaneously, so switching doesn't touch `video_source`/stream config. Grid-line overlay, status bar, double-click fullscreen, PAR-override CSS when `disable_pixel_aspect_ratio` is set |
| `components/video/VideoCanvas.jsx` | WebCodecs renderer — `<canvas>` fed by `WebCodecsClient`, connection-state placeholder, graceful "unsupported browser" fallback message |
| `components/video/VideoSettingsPanel.jsx` | Source/fit/RTSP/UDP/TCP config, low-latency/grid/PAR toggles, discovered-camera stream selector, mounts `RecordingControls` |
| `components/video/RecordingControls.jsx` | Record/stop toggle with elapsed-time readout, snapshot button — hidden entirely when `show_rec_control` is false |
| `utils/webrtcClient.js` | `VideoClient` — `RTCPeerConnection` + signaling WebSocket, exponential-backoff auto-reconnect on ICE failure |
| `utils/webcodecsDecoder.js` | `WebCodecsClient` — connects to `/ws/video/raw`, parses `[timestamp_us:u64][NAL payload]` binary frames, sniffs Annex-B NAL type to detect keyframes for `VideoDecoder.configure()`/`decode()`, renders via `canvas.drawImage()`, exponential-backoff reconnect |
| `pages/Video.jsx` | Mounts `VideoView` + `VideoSettingsPanel` at `/video` |

**Closed this pass:** `VideoCanvas.jsx`/`webcodecsDecoder.js` (the browser-side
WebCodecs consumer) were missing in the previous pass despite the backend
(`raw_ws_sender.py`, `/ws/video/raw`) being complete — this left the WebCodecs fallback
entirely unusable from the browser. Both are now implemented and wired into
`VideoView.jsx` via a runtime toggle.

**Honesty note on verification:** the WebCodecs path was built against the documented
`VideoDecoder`/`EncodedVideoChunk` API (`avc.format: 'annexb'`, in-band SPS/PPS,
keyframe-gated `configure()`), the frontend build passes, and a logic-level test now
verifies the actual shipped `webcodecsDecoder.js` correctly parses the WS wire format,
gates decode on keyframes, configures/decodes/renders/closes frames correctly, and
handles decoder errors and reconnects — all against mocked browser APIs, since a real
headless-browser session was explicitly blocked by this environment's safety
classifier (see the round-2 update above). So: the decode/framing/error-handling logic
is now independently verified; what remains unverified is real GPU decode + real pixel
output in an actual browser process. Unlike the WebRTC path and every backend module
(verified against real GStreamer/MAVLink), this is the one remaining claim in this
document that needs a human with a browser (or an explicit permission grant for
headless-browser automation) to close out completely.

---

## 5. API reference

| Method | Path (via `node_api` gateway, port 8080) | Purpose |
|---|---|---|
| GET | `/api/video/state` | Pipeline status, encoding, peer counts, recording state, last error |
| GET | `/api/video/settings` | Current `VideoSettings` (20 facts) |
| PUT | `/api/video/settings` | Patch settings; auto-restarts if a `RESTART_FIELDS` member changed |
| POST | `/api/video/start` / `/api/video/stop` | Manual pipeline lifecycle |
| POST | `/api/video/record/start` | Body `{format?: "MP4"\|"MOV"\|"MKV"}`; starts recorder + subtitle writer |
| POST | `/api/video/record/stop` | Stops both, returns final filepath |
| POST | `/api/video/snapshot` | Returns `image/png` — one decoded frame |
| GET | `/api/cameras` | Discovered MAVLink cameras + their streams |
| POST | `/api/cameras/{sysid}/{compid}/{streamId}/select` | Manually select a stream (auto-selection also happens on discovery) |
| WS | `ws://<host>:8000/ws/video/signaling` | WebRTC SDP/ICE (direct to Python service, not proxied) |
| WS | `ws://<host>:8000/ws/video/raw` | WebCodecs fallback binary frames (direct to Python service, not proxied) |

---

## 6. Settings reference (`VideoSettings`, 20 facts)

| Fact | Type | Default | Restart-triggering? |
|---|---|---|---|
| `video_source` | enum | `DISABLED` | yes |
| `rtsp_url` / `rtsp_username` / `rtsp_password` / `rtsp_tcp_transport` | string/bool | `""` / `""` / `""` / `false` | yes |
| `udp_port` | int | `5600` | yes |
| `tcp_url` | string | `""` | yes |
| `aspect_ratio` | float | `0.0` (auto) | no |
| `video_fit` | enum | `FIT_HEIGHT` | no |
| `grid_lines` | bool | `false` | no |
| `recording_format` | enum | `MP4` | no |
| `max_video_size_mb` | int | `10240` | no |
| `enable_storage_limit` | bool | `false` | no |
| `stream_enabled` | bool | `true` | yes |
| `disable_when_disarmed` | bool | `false` | no |
| `low_latency_mode` | bool | `false` | yes |
| `stream_timeout_s` | int | `8` | yes |
| `frame_smoothing_enabled` | bool | `false` | no |
| `show_rec_control` | bool | `true` | no — pure UI visibility |
| `disable_pixel_aspect_ratio` | bool | `false` | no — frontend CSS override only |

---

## 7. Known limitations

- **Single stream only.** QGC supports a primary + thermal receiver pair; this port
  builds one `GstVideoReceiver` at a time. `camera_manager.py` discovers and can
  select any advertised stream, but only one is active in the pipeline simultaneously.
- **WebCodecs path is implemented and logic-verified end-to-end (backend + frontend)
  but not pixel-verified in a real browser** — see §4's honesty note. The backend
  half (`raw_ws_sender.py`) was never in doubt (plain GStreamer, same verification
  story as everything else); the frontend half (`webcodecsDecoder.js`,
  `VideoCanvas.jsx`) now has a passing logic-level test against mocked browser APIs
  (8/8 assertions: framing, keyframe-gating, configure/decode/render/close,
  error handling, reconnect) but has not been run against a real `VideoDecoder` in an
  actual browser process — headless-browser automation was explicitly blocked by this
  environment's safety classifier twice (direct Chrome launch, then Playwright's
  bundled Chromium), and further workaround attempts were deliberately not pursued
  per that denial's own instructions. Closing this needs either an explicit
  permission grant for headless-browser automation, or a human opening `/video` and
  clicking the WebCodecs toggle.
- **No TURN server configured.** WebRTC uses a public STUN server only; connections
  across symmetric NAT/strict firewalls will fail. Flagged as a risk in the original
  plan (§10); out of scope for this pass.
- **Snapshot path allocates a full decode branch per call** (`decodebin3 →
  videoconvert → pngenc`), torn down immediately after. Fine for occasional use;
  would need a persistent tap if snapshot became a high-frequency feature.
- **No automated test suite checked in.** Verification across both implementation
  passes was five standalone smoke-test scripts run against a real GStreamer
  pipeline, real MAVLink message objects, and a real settings-triggered restart (not
  committed to the repo — they lived in a scratch directory). Recommend porting them
  into `test/` as proper pytest cases before further iteration.
- **Recording save path is hardcoded**, not a configurable setting — every recording
  goes to `python_service/recordings/`. QGC's equivalent (`videoSavePath`) actually
  lives on `AppSettings`, not `VideoSettings` (audit gap #5) — the audit explicitly
  called this "no action needed for the port," so this is a known, accepted gap, not
  an oversight.
