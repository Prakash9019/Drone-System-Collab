# Video Subsystem — Architecture Analysis & Migration Plan

Reverse-engineered from QGroundControl `qgroundcontrol/src/VideoManager/` and adapted to our stack (React + Python FastAPI + Node API). All file references are to the QGC clone unless prefixed with `drone_gcs/`.

---

## 0. Stack Adaptation — The Critical Difference

QGC is a Qt/C++ desktop app. Its video pipeline ends in a **QML `VideoOutput`** fed by a custom GStreamer sink (`qgcvideosinkbin`) that hands `QVideoFrame`s to Qt's RHI for GPU-accelerated rendering (`GstAppSinkAdapter.cc:350-400`). The entire pipeline — source, demux, decode, render — lives in one process and shares a GL context with the UI.

We run a **web browser**. A browser cannot host a GStreamer pipeline. The decode must either:

1. **Happen in the backend** (Python service, terminates the drone stream, transcodes/repackages, ships to browser over WebRTC / WebSocket-MSE), **OR**
2. **Happen in the browser** using `WebCodecs API` fed raw H.264 NAL units over WebSocket.

This plan recommends a **hybrid**: backend-side GStreamer for source-protocol handling (RTSP/UDP-RTP/TCP-MPEG-TS/MPEG-TS) — *identical* to QGC's job up to the parser — then a WebRTC sender (primary path) or WebCodecs feeder (low-latency fallback) to the browser. QGC's `VideoManager`/`VideoReceiver` decomposition maps cleanly onto Python; only the QML sink is replaced.

---

## 1. QGC Architecture Map (the parts we're porting)

### 1.1 Class hierarchy
- **`VideoManager`** (`src/VideoManager/VideoManager.cc`, singleton via `Q_APPLICATION_STATIC`) — orchestrator. Owns up to 2 `VideoReceiver`s (primary + thermal/secondary), wires VideoSettings facts, restarts pipelines on setting changes, manages MAVLink-advertised stream URIs via `_updateAutoStream` (`VideoManager.cc:595-647`).
- **`VideoReceiver`** (`src/VideoManager/VideoReceiver/VideoReceiver.h`) — abstract: `start/stop/startDecoding/stopDecoding/startRecording/stopRecording/takeScreenshot` + signals `streamingChanged / decodingChanged / recordingChanged / videoSizeChanged / timeout / onStartComplete / onStopComplete`.
- **`GstVideoReceiver`** (`src/VideoManager/VideoReceiver/GStreamer/GstVideoReceiver.cc`) — production impl. Programmatic pipeline (NOT `gst_parse_launch`), tee + valves topology.
- **`GStreamer` namespace** (`src/VideoManager/VideoReceiver/GStreamer/GStreamer.cc`) — `prepareEnvironment()`, `initialize()`, static-plugin registration, `setCodecPriorities()`, `createVideoSink()`.
- **`GstAppSinkAdapter`** (`...GStreamer/GstAppSinkAdapter.cc`) — pulls samples from `appsink`, wraps as `QVideoFrame` (zero-copy on DMABuf/GLMemory/D3D11/AHB; memcpy fallback).
- **`SubtitleWriter`** (`src/VideoManager/SubtitleWriter.cc`) — embeds telemetry as SRT subtitles during recording.
- **`VideoSettings`** (`src/Settings/VideoSettings.cc/.h` + `Video.SettingsGroup.json`) — 20 Facts: `videoSource, udpUrl, tcpUrl, rtspUrl, aspectRatio, videoFit, gridLines, recordingFormat, maxVideoSize, enableStorageLimit, rtspTimeout, streamEnabled, lowLatencyMode, forceVideoDecoder, forceCpuVideoPath, videoConversionElement, disablePixelAspectRatio, frameSmoothingEnabled, ...`.
- **`QGCCameraManager` + `VehicleCameraControl`** (`src/Camera/`) — MAVLink camera discovery, `CAMERA_INFORMATION` + `VIDEO_STREAM_INFORMATION` request/parse, advertises stream metadata to `VideoManager`.

### 1.2 Pipeline graph (programmatic, not parse-launch)

```
              ┌─→ queue ─→ _decoderValve ─→ decodebin3 ─→ qgcvideosinkbin ─→ QVideoSink
_source ─→ _tee
              └─→ queue ─→ _recorderValve ─→ mux + filesink ─→ MP4/MKV
```

`tee` + two `valve` elements give independent control of decode and record branches without rebuilding the pipeline (`GstVideoReceiver.cc:59-218`). `_decoderValve.drop` starts `TRUE`; opens when `startDecoding()` is called. Same for `_recorderValve`. A keyframe probe (`GstVideoReceiver.cc:504-515`) defers the record-branch open until the first IDR so the file is playable.

### 1.3 Source elements by protocol (`_makeSource`, `GstVideoReceiver.cc:672-883`)

| Protocol | Element | Key knobs |
|---|---|---|
| RTSP | `rtspsrc` | `latency=25 ms`, `do-rtcp=TRUE`, `tcp-timeout=5s`, `udp-reconnect=TRUE`, `drop-on-latency=TRUE`, `retry=3` |
| UDP H.264/H.265 | `udpsrc` + RTP caps filter (`application/x-rtp, encoding-name=H264\|H265`) | `buffer-size=8 MB` |
| TCP MPEG-TS | `tcpclientsrc` + `tsdemux` | `host`, `port` |
| UDP MPEG-TS | `udpsrc` + `tsdemux` | — |

All sources flow into a `sourcebin` wrapper containing `parsebin` and (for RTP) an `rtpjitterbuffer` (`do-lost=TRUE`, `drop-on-latency` toggled by `lowLatencyMode`).

### 1.4 Decoder selection
- `decodebin3` auto-plugs. QGC's `setCodecPriorities()` (`GStreamerHelpers.cc:203-260`) bumps a chosen family to `GST_RANK_PRIMARY + 1`. Families: `default | software | hardware | VAAPI | NVIDIA | DirectX | VideoToolbox | Intel | Vulkan`.
- HW detection (`GStreamerHelpers.cc:40-96`) heuristics on factory name prefix + metadata klass.
- After decode plugs, QGC explicitly `g_object_set(decoder, "qos", FALSE)` (`GstVideoReceiver.cc:1051-1056`) — **critical**: without this the videodecoder base class cascade-drops frames after a single late one.

### 1.5 Render sink
- Custom `qgcvideosinkbin` bin element. Construct-only `gpu-zerocopy` property:
  - **GPU path**: `[glupload →] appsink` with caps allow-list `GLMemory | DMABuf | D3D11Memory | D3D12Memory | AHardwareBuffer | x-raw`. Zero-copy `QVideoFrame` via custom `GstDmaBufVideoBuffer / GstGlVideoBuffer / GstD3D11VideoBuffer`.
  - **CPU path**: `[SoC converter | videoconvert] → [capsfilter PAR=1/1] → appsink`. SoC-native converters preferred (`imxvideoconvert_g2d`, `nvvidconv`).
- `appsink` always: `max-buffers=1, drop=TRUE, sync=FALSE, max-lateness=-1, emit-signals=FALSE` (`GstVideoReceiver.cc:1144-1184` + `gstqgcvideosinkbin.cc:287-488`). Frames pulled by `GstAppSinkAdapter` and pushed to `QVideoSink` via queued metaobject invocation.

### 1.6 Watchdog & reconnect
- Tee-pad probe `_teeProbe` updates `_lastSourceFrameTime` on every buffer (`GstVideoReceiver.cc:104-112`).
- `_watchdog()` (`GstVideoReceiver.cc:576-610`) fires every second; if `now - _lastSourceFrameTime > _timeout` → emit `timeout`, stop pipeline. Decoder timeout is `2× _timeout` (allows codec init).
- `_onBusMessage` (`GstVideoReceiver.cc:1401-1499`) handles `GST_MESSAGE_ERROR` (stop), `WARNING` (log), `EOS` (stop or loop), `STREAM_COLLECTION` (filter audio out), `QOS` (log metrics).
- `VideoManager` reacts to `timeout` → `_restartVideo()` (`VideoManager.cc:785-800`).

### 1.7 Threading
- `VideoManager` runs on the Qt main thread.
- `GStreamer::initialize` runs once in `QtConcurrent::run` (`VideoManager.cc:83-100`).
- Each `GstVideoReceiver` has its own worker thread (`_worker->dispatch(...)`) — all bus messages and pipeline mutations dispatched there.
- Sample pull happens on the GStreamer streaming thread inside `appsink`; the frame push to `QVideoSink` is `QMetaObject::invokeMethod(..., Qt::AutoConnection)` → marshals to the sink's thread.

### 1.8 MAVLink camera handshake (`QGCCameraManager.cc:201-556`, `VehicleCameraControl.cc:1672-1712`)

```
Camera Component → HEARTBEAT → CameraManager._handleHeartbeat
                          ↓
CameraManager → MAV_CMD_REQUEST_MESSAGE(CAMERA_INFORMATION) → Camera
(alternates with MAV_CMD_REQUEST_CAMERA_INFORMATION on retry)
                          ↓
Camera → CAMERA_INFORMATION → CameraManager._handleCameraInfo
                              create VehicleCameraControl, aspect ratio
                          ↓
Camera → VIDEO_STREAM_INFORMATION × N (one per stream_id 0..4)
       → VehicleCameraControl.handleVideoStreamInformation
       → QGCVideoStreamInfo per stream
       → _streamInfoTimer (1s) waits until count matches
                          ↓
       emit streamChanged → VideoManager._updateAutoStream
       → maps stream_type/encoding to {videoSource, rtspUrl|udpUrl|tcpUrl}
       → sets VideoSettings facts
       → fact change triggers _restartAllVideos → receiver.start()
```

Stream fields read: `stream_id, type, uri, encoding, resolution_h/v, hfov, framerate, bitrate, flags (RUNNING/THERMAL), rotation, name`.

### 1.9 Settings → restart flow
1. UI fact mutation (QML `Fact.setRawValue` or auto-stream).
2. `Fact::rawValueChanged` → `VideoManager::_videoSourceChanged` (`VideoManager.cc:521-556`).
3. `_updateSettings(receiver)` returns true if URI/source/lowLatency/decoder/aspect changed.
4. If changed → `_restartVideo(receiver)` → stop, on `onStopComplete` restart.

---

## 2. Target Architecture for Drone GCS

### 2.1 High-level data flow

```
┌──────────────┐     drone-side stream (RTSP / UDP-RTP / TCP-MPEG-TS / MPEG-TS)
│  Vehicle FC  │ ─────────────────────────────────────────────────────────┐
└──────┬───────┘                                                          │
       │ MAVLink (CAMERA_INFO, VIDEO_STREAM_INFO)                         │
       ▼                                                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ python_service/video_service/                                                │
│                                                                               │
│  ┌──────────────────┐  ┌────────────────────────┐  ┌──────────────────────┐ │
│  │ VideoManager.py  │→ │ GstVideoReceiver.py    │→ │ WebRTC sender       │ │
│  │ (orchestrator)   │  │ (per-stream pipeline)  │  │ (aiortc / gst-webrtc)│ │
│  └────────┬─────────┘  └────────────────────────┘  └──────────┬───────────┘ │
│           │                                                    │             │
│           │ ┌──────────────────┐  ┌──────────────────┐         │             │
│           ├→│ Recorder branch  │  │ Subtitle writer  │         │             │
│           │ │ (tee+valve+mux)  │  │ (SRT telemetry)  │         │             │
│           │ └──────────────────┘  └──────────────────┘         │             │
│           │                                                    │             │
│           │ ┌─────────────────────────────────────────┐        │             │
│           └→│ CAMERA_INFORMATION / VIDEO_STREAM_INFO  │        │             │
│             │ handler (via existing mavlink_link.py)  │        │             │
│             └─────────────────────────────────────────┘        │             │
│                                                                │             │
│  REST: /api/video/state, /api/video/start, /api/video/stop,    │             │
│        /api/video/record/{start,stop}, /api/video/snapshot     │             │
│  WS:   /ws/video/signaling  (WebRTC SDP+ICE)                   │             │
│  WS:   /ws/video/raw        (fallback: H.264 NAL frames)       │             │
└─────────────────────────────────────────────────────────────────│─────────────┘
                                                                  │
                                                                  ▼ WebRTC SRTP
┌─────────────────────────────────────────────────────────────────────────────┐
│ frontend/                                                                    │
│  ┌────────────────────────┐  ┌─────────────────────────────┐                │
│  │ useVideoStore.js       │  │ VideoView.jsx               │                │
│  │ (Zustand: source,      │← │ (WebRTC <video> + overlay   │                │
│  │  url, port, fit,       │→ │  HUD, fit modes, fullscreen)│                │
│  │  recording, streams[]) │  └─────────────────────────────┘                │
│  └────────────────────────┘                                                  │
│  ┌────────────────────────┐  ┌─────────────────────────────┐                │
│  │ VideoSettingsPanel.jsx │  │ webrtcClient.js / wcDecoder │                │
│  │ (source dropdown, URL, │  │ (signaling + transport)     │                │
│  │  port, fit, low-lat)   │  └─────────────────────────────┘                │
│  └────────────────────────┘                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Why WebRTC (primary) + WebCodecs (fallback)
| Transport | Latency (LAN, 30 fps) | Browser support | Backend complexity | Recommended |
|---|---|---|---|---|
| WebRTC (H.264) | 80–200 ms | All modern | Medium (signaling + ICE + SRTP) | ✅ Primary |
| WebCodecs + WS | 50–120 ms | Chrome/Edge/Safari 16.4+ | Low (just send NAL units) | ✅ Fallback / FPV-optimized |
| MSE (fragmented MP4) | 400 ms – 2 s | All | Medium (fMP4 mux) | ⚠ Compat-only |
| HLS | 3–10 s | All | Low | ❌ Unacceptable for FPV |
| MPEG-TS over WS (jsmpeg) | 200–500 ms | All | Low | ⚠ Acceptable fallback |

Production primary path is WebRTC because it negotiates codec/bandwidth, handles NACK/PLI loss recovery, and is the closest analog to QGC's GStreamer-direct-to-display behavior. WebCodecs is the FPV-optimized path for users who want absolute minimum latency and have a modern browser.

### 2.3 Backend pipeline (Python + GStreamer via `python-gi`)

Mirror QGC's tee+valves topology, but the GPU sink is replaced by a **WebRTC `webrtcbin`** branch and the recorder branch is identical.

```
rtspsrc/udpsrc/tcpclientsrc ─→ parsebin ─→ tee ─┬─→ queue ─→ valve_webrtc ─→ webrtcbin ──╮
                                                │                                          ├─→ browser
                                                └─→ queue ─→ valve_record ─→ mp4mux ─→ filesink
                                                       │
                                                       └─→ optional appsink → /ws/video/raw (WebCodecs fallback)
```

Element knobs ported verbatim from QGC (proven defaults):
- `rtspsrc`: `latency=25, do-rtcp=TRUE, tcp-timeout=5000000, udp-reconnect=TRUE, drop-on-latency=TRUE, retry=3`
- `udpsrc`: `buffer-size=8388608` (8 MiB)
- `rtpjitterbuffer`: `do-lost=TRUE, drop-on-latency=lowLatency`
- `appsink`: `max-buffers=1, drop=TRUE, sync=FALSE, max-lateness=-1`
- Disable `qos` on the auto-plugged decoder if we go through decodebin (we *don't* for the WebRTC primary — we keep encoded H.264 end-to-end, no transcode).
- `mp4mux faststart=TRUE, reserved-moov-update-period=1000000000` for crash-safe recordings.

**Key advantage over QGC**: WebRTC carries encoded H.264 through `rtpvp8pay/rtph264pay` — *no decode in the backend*. Decode happens on the GPU in the browser via WebRTC's hardware path. CPU/GPU on the GCS host is freed for telemetry.

### 2.4 Frontend rendering
- A `<video>` element with `srcObject = peerConnection.streams[0]` for WebRTC.
- For WebCodecs fallback: a `<canvas>` with `VideoDecoder` configured from `avcC` SPS/PPS extracted on the backend.
- Overlay layer (HUD) is a CSS-positioned absolute div on top — the existing `AdvancedHUD.jsx` can be reused.
- Fit modes: `object-fit: contain | cover | fill | scale-down` map directly to QGC's `Fit Width / Fit Height / Fill / No Crop`.
- Fullscreen: `videoElement.requestFullscreen()`.
- Aspect ratio: prefer stream-reported (from `RTP/codec-private` parsed in backend, sent in signaling) → fallback to user setting.

### 2.5 Settings model (port from QGC `VideoSettings`)

| Frontend store key | Backend key | Type / values | Default | Notes |
|---|---|---|---|---|
| `videoSource` | `video_source` | enum: `DISABLED \| RTSP \| UDP_H264 \| UDP_H265 \| TCP_MPEGTS \| UDP_MPEGTS \| MAVLINK_AUTO` | `MAVLINK_AUTO` | replaces QGC's vendor-specific entries (3DR Solo, Yuneec etc.) which we don't need |
| `rtspUrl` | `rtsp_url` | string | `""` | |
| `udpPort` | `udp_port` | int 1–65535 | `5600` | also accepts full URL form `udp://0.0.0.0:5600` |
| `tcpUrl` | `tcp_url` | string | `""` | |
| `aspectRatio` | `aspect_ratio` | float | `0` (auto) | |
| `videoFit` | `video_fit` | enum: `FIT_WIDTH \| FIT_HEIGHT \| FILL \| NO_CROP` | `FIT_HEIGHT` | maps to `object-fit` |
| `gridLines` | `grid_lines` | bool | `false` | |
| `recordingFormat` | `recording_format` | enum: `MP4 \| MKV \| MOV` | `MP4` | |
| `maxVideoSize` | `max_video_size_mb` | int | `10240` | |
| `enableStorageLimit` | `enable_storage_limit` | bool | `false` | |
| `streamEnabled` | `stream_enabled` | bool | `true` | |
| `disableWhenDisarmed` | `disable_when_disarmed` | bool | `false` | |
| `lowLatencyMode` | `low_latency_mode` | bool | `false` | toggles jitterbuffer `drop-on-latency` |
| `forceVideoDecoder` | `force_video_decoder` | enum: `AUTO \| SW \| HW` | `AUTO` | applied only on WebCodecs fallback (browser-side); on WebRTC the browser chooses |
| `streamTimeout` | `stream_timeout_s` | int | `8` | watchdog |
| `frameSmoothingEnabled` | `frame_smoothing_enabled` | bool | `false` | |

Persist via the same mechanism as our other Zustand stores (localStorage on FE; JSON file on BE — same pattern as `osd_profiles.json`).

### 2.6 MAVLink camera integration (port `QGCCameraManager`)

Add to `python_service/`:
- `camera_manager.py` — listens on the existing MAVLink mux (`mavlink_link.py`), on HEARTBEAT with `compid ∈ {MAV_COMP_ID_CAMERA..CAMERA6}` triggers `MAV_CMD_REQUEST_MESSAGE(CAMERA_INFORMATION)` with retry/back-off.
- Parse `CAMERA_INFORMATION` → store model/firmware/flags/resolution → expose via `/api/cameras`.
- Request `VIDEO_STREAM_INFORMATION` for each declared stream → assemble list keyed by `stream_id`.
- Push stream URIs into `VideoManager._update_auto_stream()` — auto-fills `video_source` + URL.
- Subscribe to `VIDEO_STREAM_STATUS` (periodic) → publish bitrate/fps/flags via existing telemetry WS.

Stream type → settings mapping (matches QGC's `_updateAutoStream`):

| `VIDEO_STREAM_TYPE_*` | `encoding` | `video_source` | URL handling |
|---|---|---|---|
| `RTSP` | * | `RTSP` | `rtsp_url = uri` |
| `RTPUDP` | `H264` | `UDP_H264` | parse port from `uri`, set `udp_port`; if uri has scheme use as-is |
| `RTPUDP` | `H265` | `UDP_H265` | same |
| `TCP_MPEG` | * | `TCP_MPEGTS` | `tcp_url = uri` |
| `MPEG_TS` | * | `UDP_MPEGTS` | `udp_port` |

---

## 3. Recommended Folder Structure

```
drone_gcs/
├── python_service/
│   ├── video_service/                  # NEW — mirrors qgc src/VideoManager
│   │   ├── __init__.py
│   │   ├── video_manager.py            # orchestrator (singleton-ish; module-level)
│   │   ├── gst_video_receiver.py       # one per active stream
│   │   ├── webrtc_sender.py            # aiortc OR webrtcbin wrapper
│   │   ├── raw_ws_sender.py            # WebCodecs fallback
│   │   ├── recorder.py                 # tee/valve/mux/filesink helpers
│   │   ├── subtitle_writer.py          # SRT telemetry inserter
│   │   ├── settings.py                 # VideoSettings dataclass + persistence
│   │   └── pipeline_factory.py         # gst element builders (rtspsrc/udpsrc/...)
│   ├── camera_manager.py               # NEW — MAVLink CAMERA_INFO / VIDEO_STREAM_INFO
│   └── main.py                         # extend with /api/video/* routes + /ws/video/*
│
├── frontend/src/
│   ├── pages/
│   │   └── Video.jsx                   # NEW (or merge into FlightData.jsx as a panel)
│   ├── components/video/               # NEW
│   │   ├── VideoView.jsx               # <video> + WebRTC client
│   │   ├── VideoCanvas.jsx             # WebCodecs <canvas> path
│   │   ├── VideoSettingsPanel.jsx      # source dropdown + URL/port/fit/etc.
│   │   ├── VideoOverlay.jsx            # HUD overlay on top of stream
│   │   └── RecordingControls.jsx
│   ├── store/
│   │   └── useVideoStore.js            # NEW (Zustand, same pattern as useMissionStore)
│   ├── telemetry/
│   │   └── videoSelectors.js           # NEW (state.cameras, streams, activeStreamId)
│   └── utils/
│       ├── webrtcClient.js             # SDP/ICE signaling + PeerConnection lifecycle
│       └── webcodecsDecoder.js         # VideoDecoder feeder
│
└── VIDEO_SUBSYSTEM_PLAN.md             # this file
```

Files marked NEW. No file in QGC's `VideoManager/` translates 1:1 — we keep the *shape* (manager + receiver + settings + camera manager) but the implementation language and rendering target change.

---

## 4. Backend Module Specifications

### 4.1 `video_manager.py` (mirrors `VideoManager.cc`)

Responsibilities:
- Singleton-ish (module-level instance imported by FastAPI routes).
- Holds 0–N `GstVideoReceiver` instances keyed by `stream_id` (primary + thermal).
- Subscribes to settings-change events; on `videoSource | rtspUrl | udpPort | tcpUrl | lowLatencyMode` change → `_restart(receiver)`.
- Exposes async methods: `start()`, `stop()`, `start_recording(path)`, `stop_recording()`, `snapshot()`, `current_state()`.
- Watchdog timer (asyncio) re-emits restart on receiver `timeout` event.
- `update_auto_stream(stream_info)` — called by `camera_manager.py` when a `VIDEO_STREAM_INFORMATION` arrives; sets settings then triggers restart.

### 4.2 `gst_video_receiver.py` (mirrors `GstVideoReceiver.cc`)

```python
class GstVideoReceiver:
    def __init__(self, uri: str, low_latency: bool, timeout_s: int):
        self._uri = uri
        self._pipeline = None
        self._tee = None
        self._decoder_valve = None
        self._recorder_valve = None
        self._webrtc = None
        self._last_frame_ts = None

    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    async def start_recording(self, path: str, fmt: str) -> None: ...
    async def stop_recording(self) -> None: ...
    async def snapshot(self) -> bytes: ...
```

Internally use `gi.repository.Gst, GstWebRTC`. Build elements with `Gst.ElementFactory.make` — no `parse_launch`. Replicate QGC's source-selection switch (`_makeSource`, `GstVideoReceiver.cc:672-883`).

Bus message handler maps GST messages to async events on an `asyncio.Queue` (same role as QGC's `_worker->dispatch`). EOS / ERROR → stop. STREAM_COLLECTION → select-streams (filter audio).

### 4.3 `webrtc_sender.py`

Two implementations possible:

**Option A — `webrtcbin` (preferred; same process):**
- Add a `webrtcbin` element after `tee`. Use `rtph264pay → webrtcbin`. Negotiate via SDP through a FastAPI `/ws/video/signaling` endpoint.
- Pros: zero-copy from source to WebRTC, no transcoding, lowest latency, same process as the rest of the pipeline.
- Cons: requires `gst-plugins-bad webrtc`. Already needed for `rtspsrc`/`udpsrc` so usually present.

**Option B — `aiortc` (pure Python):**
- Inject H.264 RTP from a `appsink` into an `aiortc.RTCPeerConnection` track. More complex; useful only when `webrtcbin` is unavailable.

Recommend Option A.

### 4.4 `raw_ws_sender.py` (WebCodecs path)

`appsink → emit-signals=TRUE → on-new-sample` reads `Gst.Buffer`, extracts the encoded NAL units (already aggregated by `h264parse` upstream), pushes over `/ws/video/raw` as binary frames with a 8-byte header `[timestamp_us:u64]` + NAL payload. SPS/PPS sent on connect.

### 4.5 `subtitle_writer.py`

Subscribe to existing telemetry stream (`telemetry_pub.py`). On `recording_start` open `<videoFile>.srt`. Every 1s write an SRT block with `lat, lon, alt, speed, heading, battery`. Closes on `recording_stop`. (Direct port of QGC's `SubtitleWriter.cc`.)

### 4.6 FastAPI routes (extend `main.py`)

```
GET    /api/video/state          → { active, source, uri, recording, decoder, bitrate, fps, resolution, streams[] }
POST   /api/video/start          → start active receiver
POST   /api/video/stop           → stop
POST   /api/video/record/start   → body: { filename?, format }
POST   /api/video/record/stop
POST   /api/video/snapshot       → returns image/png
GET    /api/video/settings       → full settings JSON
PUT    /api/video/settings       → patch settings; triggers restart if relevant
GET    /api/cameras              → list of MAVLink-discovered cameras + streams
POST   /api/cameras/{stream_id}/select  → set as active
WS     /ws/video/signaling       → SDP offer/answer + ICE
WS     /ws/video/raw             → fallback WebCodecs feed (binary frames)
```

---

## 5. Frontend Module Specifications

### 5.1 `useVideoStore.js` (Zustand, pattern-match `useMissionStore`)

State: `{ settings, status, cameras, streams, activeStreamId, recording, decoderStats, peer: null }`.
Actions: `setSetting, applySettings, startStream, stopStream, startRecording, stopRecording, takeSnapshot, selectStream, _onAutoStreamUpdate, _onCameraDiscovered`.
Persist `settings` to localStorage; sync with backend on mount.

### 5.2 `webrtcClient.js`

```js
export async function connectVideo(videoEl, signalingUrl) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pc.ontrack = (e) => { videoEl.srcObject = e.streams[0]; };
  const ws = new WebSocket(signalingUrl);
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === 'offer') {
      pc.setRemoteDescription(msg)
        .then(() => pc.createAnswer())
        .then(a => { pc.setLocalDescription(a); ws.send(JSON.stringify(a)); });
    } else if (msg.type === 'ice') {
      pc.addIceCandidate(msg.candidate);
    }
  };
  pc.onicecandidate = (e) => e.candidate && ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate }));
  return { pc, ws };
}
```

Reconnect logic: on `pc.oniceconnectionstatechange === 'failed'` → close peer, wait 1 s, retry up to 5× with exponential back-off.

### 5.3 `VideoView.jsx`

Uses `useShallow` from zustand/react/shallow when reading composite settings (same pattern we use in `Params.jsx` and now `MapEditor.jsx`). Owns a `videoRef` and on mount calls `connectVideo(videoRef.current, '/ws/video/signaling')`. Renders status banner on disconnect. Double-click toggles fullscreen.

### 5.4 `VideoSettingsPanel.jsx`

Source dropdown, URL/port inputs (conditional on source), fit dropdown (`object-fit`), low-latency toggle, decoder preference, recording format, max-size, grid-lines toggle. Each control debounced 300 ms before `PUT /api/video/settings`.

### 5.5 Where to mount in routes
- Either a new `/video` page, OR
- A panel inside the existing `/flight` (`FlightData.jsx`) — recommended; FPV is usually consumed while flying. Layout: video as background, telemetry HUD overlay (reuse `AdvancedHUD.jsx`).

---

## 6. Recommended Development Order

1. **Bootstrap GStreamer in Python** — verify `gi.repository.Gst` import, run a hello-world `videotestsrc → autovideosink`. Document the host's required apt/brew packages (`gstreamer-1.0`, `gst-plugins-base/good/bad/ugly`, `gst-libav`, `gst-plugins-bad` for `webrtcbin`).
2. **Standalone `gst_video_receiver.py`** — just RTSP → autovideosink, with the QGC element knobs. Validate against any RTSP source (e.g., `rtsp://wowzaec2demo.streamlock.net/vod/mp4:BigBuckBunny_115k.mp4`).
3. **Add `tee` + record valve** — write MP4. Verify faststart works (kill process mid-record; file still plays).
4. **Watchdog + reconnect** — replicate `_watchdog`/`_lastSourceFrameTime`. Test by yanking the network.
5. **WebRTC sender path** — replace `autovideosink` with `webrtcbin`. Add `/ws/video/signaling` route. Render in a test HTML page first.
6. **Frontend WebRTC client + `<video>`** — wire into React. Verify glass-to-glass latency.
7. **Settings store + UI panel** — port the 16 facts. Wire restart-on-change.
8. **MAVLink `camera_manager.py`** — parse `CAMERA_INFORMATION` / `VIDEO_STREAM_INFORMATION`. Test with PX4 SITL + GStreamer simulated stream.
9. **Auto-stream** — wire `video_manager.update_auto_stream`.
10. **Recording UI + telemetry SRT** — port `SubtitleWriter`.
11. **Multi-stream support** — second `GstVideoReceiver` for thermal. Stream selector UI.
12. **WebCodecs fallback path** — `raw_ws_sender.py` + `webcodecsDecoder.js`. Toggle via setting.
13. **HW-decoder preference** — only meaningful in WebCodecs fallback; on WebRTC the browser decides.
14. **Stability hardening** — long-soak test (8 h), packet-loss test (`tc qdisc add ... netem loss 5%`), reconnect storms.

Each step ends with a manual smoke test in the browser at `/flight` (or `/video`).

---

## 7. Latency Budget (target: < 200 ms glass-to-glass, LAN, H.264 1080p30)

| Stage | Budget | Knob |
|---|---|---|
| Camera encode | 16–33 ms | drone side, out of scope |
| Network (LAN) | 1–10 ms | — |
| `rtspsrc` / `rtpjitterbuffer` | 25 ms | `latency=25` (QGC default) |
| `h264parse` (passthrough) | < 1 ms | — |
| `webrtcbin` RTP repack | 1–5 ms | — |
| Network (server→browser) | 1–10 ms | LAN |
| Browser jitter buffer | 20–50 ms | `playoutDelayHint=0` on the `RTCRtpReceiver` |
| Browser HW decode | 8–16 ms | one frame |
| Compositor / vsync | 16 ms | one refresh interval |
| **Total** | **~90–170 ms** | |

To hit the budget:
- Set `pc.getReceivers().forEach(r => r.playoutDelayHint = 0)` on the frontend.
- `webrtcbin` `latency=0` plus `rtpjitterbuffer-latency` overrides via `request-aux-receiver` if needed.
- `<video autoplay muted playsinline>` — no element-level latency knob, but `requestVideoFrameCallback` can measure it.

If WebRTC's adaptive jitter buffer is still too high, switch the affected stream to WebCodecs.

---

## 8. Stability & Stream Recovery

| Failure | Detection | Response |
|---|---|---|
| No source data > 8 s | watchdog (`_last_frame_ts`) | emit timeout → `_restart` (full pipeline rebuild, exponential back-off capped at 30 s) |
| `GST_MESSAGE_ERROR` | bus | log + stop + restart |
| TCP RST / RTSP teardown | `rtspsrc retry=3` then bus error | restart |
| Browser WebRTC `iceConnectionState == 'failed'` | `pc.oniceconnectionstatechange` | reconnect peer; pipeline stays running |
| Decoder cascading drops | (browser side; less relevant since we passthrough) | for WebCodecs path call `decoder.flush()` and re-send SPS/PPS |
| Recording disk full | `filesink` GST_MESSAGE_ERROR | stop recording, surface banner |

Storage-limit policy: on `recording_size > max_video_size_mb` → roll the file (close, open new with timestamped name).

---

## 9. Performance Knobs (CPU / GPU)

- **No transcode**: the WebRTC primary path keeps H.264 encoded end-to-end. The Python process spends most CPU just on `rtpjitterbuffer` and `webrtcbin` SRTP — typically < 5 % of one core for 1080p30.
- **Zero-copy not needed on backend** (we never touch raw pixels).
- **WebCodecs fallback CPU**: backend reads `Gst.Buffer` mappings (~50 MB/s for 1080p30) — keep it on a dedicated asyncio executor to avoid blocking the FastAPI event loop. The `mapinfo.data` buffer must be released promptly.
- **Browser GPU**: WebRTC uses VideoToolbox / NVDEC / VAAPI / MediaFoundation automatically when `pc.addTransceiver('video', { direction: 'recvonly', sendEncodings: [{ scalabilityMode: 'L1T1' }] })` matches a HW-decode profile.
- **Multiple peers** (multi-operator): `webrtcbin` natively supports multiple peers per bin via a fanout `tee`; but cleaner is one `GstVideoReceiver` per camera × one peer per browser client, sharing the encoded RTP via a shared `tee` element.

---

## 10. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `gst-plugins-bad` missing `webrtcbin` on target hosts | Medium | High | Pin to specific gstreamer version in install script; CI smoke test with `gst-inspect-1.0 webrtcbin` |
| WebRTC over WAN behind symmetric NAT | Medium | Medium | Provide TURN server in config (frpc.toml-style) |
| H.265 stream from drone but Safari/Chrome can't decode | Medium | Medium | Detect via `MediaCapabilities.decodingInfo`; auto-fall-back to WebCodecs which supports HEVC on macOS/Safari, or backend transcode to H.264 (last resort) |
| Browser tab throttling drops playout | Low | Medium | `Page Visibility API`: on hidden tab, downscale playoutDelayHint or pause |
| GStreamer pipeline deadlock on element add/remove | Low | High | Always pad-block before add/remove (QGC pattern in `_addRecording` / `_removeRecording`); never mutate pipeline from bus handler thread |
| Python GIL contention with high-FPS appsink callbacks | Low-Med | Medium | Keep WebRTC path (no per-frame Python callbacks); WebCodecs path uses a thread pool for buffer reads |
| Long-soak memory leak in `Gst.Buffer` mappings | Med | Med | Use `with mapinfo:` (gi 1.22+ context manager) or always `buffer.unmap(mapinfo)` in `finally` |
| Codec licensing for H.264/HEVC in distributable builds | Low | Med | Browser-side decode side-steps GCS-side licensing; documented in deployment notes |
| Recording disk fill → silent failure | Med | Med | Pre-flight disk check + storage-limit enforcement + UI banner |

---

## 11. Important Source Files to Reread Before Each Step

When implementing step N, reread the corresponding QGC source:

| Step | QGC reference files |
|---|---|
| 2 | `GstVideoReceiver.cc:672-883` (`_makeSource`), `:59-218` (`start`) |
| 3 | `GstVideoReceiver.cc:457-528` (recording), `:894-976` (`_makeFileSink`) |
| 4 | `GstVideoReceiver.cc:576-610` (`_watchdog`), `:104-112` (`_teeProbe`), `:1401-1499` (bus) |
| 5 | gst-docs `webrtcbin` + `VideoManager.cc:870` (sink wiring) |
| 7 | `VideoSettings.cc/.h`, `Video.SettingsGroup.json`, `VideoManager.cc:182-187` (fact wiring) |
| 8 | `QGCCameraManager.cc:201-556`, `VehicleCameraControl.cc:1672-1712` |
| 9 | `VideoManager.cc:595-647` (`_updateAutoStream`) |
| 10 | `SubtitleWriter.cc` |

---

## 12. Out of Scope (deliberately)

- Vendor-specific video sources (`3DR Solo`, `Yuneec Mantis G`, `Parrot Discovery`, `Herelink AirUnit/Hotspot`) — these are RTSP/UDP under the hood; covered by generic protocol support.
- UVC / local-webcam capture — relevant for QGC desktop only; in a browser the user can use `navigator.mediaDevices.getUserMedia` directly and we don't need backend involvement. Defer until requested.
- Thermal blending modes (PIP/Blend/Full) — implement basic thermal as a separate stream first; blending modes are a v2 feature once dual-stream is stable.
- Camera control (gimbal, zoom, focus, ROI) — separate subsystem (`Gimbal/`, `Camera/QGCCameraControl.cc`); video subsystem only reads `VIDEO_STREAM_INFORMATION`.
- 3D viewer (`Viewer3D/`) and analyze view (`AnalyzeView/`) — unrelated.

---

## 13. Done Criteria

The subsystem is considered shipped when all of the following hold:
- [ ] RTSP, UDP H.264, UDP H.265, TCP MPEG-TS, UDP MPEG-TS all play in `<video>` from `/flight`.
- [ ] Glass-to-glass latency (LAN) < 250 ms median, < 400 ms p99.
- [ ] 8-hour soak run: zero memory leaks (process RSS stable ± 5 %), zero unrecovered disconnects under simulated 5 % packet loss.
- [ ] MAVLink-advertised camera auto-fills settings; switching streams via UI works.
- [ ] Recording to MP4 produces playable files even when killed mid-record (faststart).
- [ ] Reconnect time after pulling Ethernet < 3 s once link is restored.
- [ ] CPU < 15 % single-core on the GCS host during 1080p30 stream + record + telemetry.
- [ ] Settings persist across restart (FE localStorage + BE JSON file).
- [ ] All settings reachable from a single panel in the UI.
