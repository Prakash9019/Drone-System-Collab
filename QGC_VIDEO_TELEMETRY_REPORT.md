# QGC Video + Telemetry Architecture Research Report

Repo: `/Users/suryprakash/Drone System Collab/qgroundcontrol`

## 1. Executive Summary

- **Video and telemetry are NOT one stream.** They are two independent transport connections, decoded by two independent code paths, that only meet in the UI as stacked QML layers.
- **Telemetry** = MAVLink bytes, parsed char-by-char by `mavlink_parse_char()` in `MAVLinkProtocol::receiveBytes()` (`src/Comms/MAVLinkProtocol.cc:113`), arriving over a `LinkConfiguration` object (UDP/TCP/Serial/Bluetooth) — default UDP port **14550** (`src/Settings/AutoConnect.SettingsGroup.json:78`).
- **Video** = a GStreamer pipeline (`rtspsrc`/`udpsrc`/`tcpclientsrc` → optional `tsdemux` → `parsebin` → `decodebin3` → custom `qgcvideosinkbin`), driven by a plain URI string, not a `LinkConfiguration` — default UDP port **5600** (`src/Settings/Video.SettingsGroup.json:19`).
- **No KLV/MISB/STANAG metadata parsing exists in QGC** — confirmed absent by repo-wide grep. `SubtitleWriter` (the closest thing to "telemetry+video") writes a `.ass` text-subtitle sidecar file, and only while actively **recording to disk** — never for live display.
- **QGC does support MPEG-TS demuxing** (`tsdemux` explicitly wired in for `mpegts://`/`tcp://` sources, `GstVideoReceiver.cc:817-833`), but this splits video+audio streams inside one transport container — it does **not** extract MAVLink/telemetry data from that container. Live telemetry is always a separate QML overlay layer (`FlyViewWidgetLayer` stacked above `FlyViewVideo` in `src/FlyView/FlyView.qml`), never demuxed out of the video bitstream.

**Verdict: the drone advisor's claim is incorrect for QGroundControl's implementation.** Video and telemetry travel as separate flows over separate sockets/ports, decoded by separate subsystems, and combined only at render time in the UI.

---

## 2. Are video and telemetry the same stream?

**No — definitively separate, on every axis checked:**

| Axis | Telemetry | Video |
|---|---|---|
| Transport class | `LinkConfiguration`/`LinkInterface` (`UDPConfiguration`, `TCPConfiguration`, `SerialConfiguration`, ...) | Plain URI string (`udp://`, `rtsp://`, `tcp://`, `mpegts://`) consumed by `VideoReceiver`/GStreamer |
| Protocol | MAVLink v1/v2 framing over UDP/TCP/Serial/Bluetooth | RTP/H.264/H.265 over UDP, RTSP, or MPEG-TS over TCP/UDP |
| Default port | **14550** (`src/Settings/AutoConnect.SettingsGroup.json:74-79`) | **5600** (`src/Settings/Video.SettingsGroup.json:16-19`) |
| Parser entry point | `mavlink_parse_char()` in `MAVLinkProtocol::receiveBytes()` (`src/Comms/MAVLinkProtocol.cc:113`) | `gst_element_factory_make()` pipeline in `GstVideoReceiver::_makeSource()` (`src/VideoManager/VideoReceiver/GStreamer/GstVideoReceiver.cc:672-863`) |
| Owning manager | `LinkManager` (`src/Comms/LinkManager.cc`) | `VideoManager` (`src/VideoManager/VideoManager.cc`) |
| Cross-references | `grep -in "mavlink" src/VideoManager/VideoReceiver/**` → **no matches** in the decode path | `grep` of `MAVLinkProtocol.cc/.h`, `Vehicle.cc/.h` for "video"/"VideoManager"/"VideoReceiver" → **no matches** |

**Structural proof of separation** — `src/Comms/LinkConfiguration.h:71-83` defines the *only* enum QGC uses for communication links:
```cpp
71:    enum LinkType {
72: #ifndef QGC_NO_SERIAL_LINK
73:        TypeSerial,
74: #endif
75:        TypeUdp,
76:        TypeTcp,
77:        TypeBluetooth,
78: #ifdef QT_DEBUG
79:        TypeMock,
80: #endif
81:        TypeLogReplay,
82:        TypeLast
83:    };
```
There is no `TypeVideo`. Video is never represented as a `LinkConfiguration` at all — it's a URI string set via `VideoManager::_updateVideoUri()` (`src/VideoManager/VideoManager.cc:649-665`) and handed straight to a `VideoReceiver`, a completely separate class hierarchy.

**The only code-level touchpoint between the two subsystems** is MAVLink *Camera Protocol control* messages — not telemetry data, not video bytes. `src/VideoManager/VideoManager.cc:719-753` (`_setActiveVehicle`):
```cpp
730:            MavlinkCameraControlInterface *pCamera = cameraManager->currentCameraInstance();
...
748:            MavlinkCameraControlInterface *pCamera = _activeVehicle->cameraManager()->currentCameraInstance();
```
These calls issue `stopStream()`/`resumeStream()` and read `VIDEO_STREAM_INFORMATION` (the stream's URI/port/encoding) over MAVLink — i.e., MAVLink is used to **tell the camera where to send video**, not to carry the video itself. Once the URI is known, video flows over its own independent GStreamer pipeline, never touching MAVLink parsing code again.

**No multiplexing found:** no MAVLink-inside-RTP, no combined-stream demuxing that separates telemetry from video. The only demuxing in the code is `tsdemux` for MPEG-TS *video* containers (video+audio elementary streams), unrelated to telemetry (see §7).

---

## 3. Video Data Flow (drone → browser/UI, step by step)

```
[Camera encoder on vehicle]
       │  H.264/H.265 over RTP-UDP, or RTSP, or MPEG-TS over TCP/UDP
       ▼
GstVideoReceiver::_makeSource()                         GstVideoReceiver.cc:672-686
  ├─ rtsp://   → gst_element_factory_make("rtspsrc")     GstVideoReceiver.cc:701
  ├─ tcp://    → gst_element_factory_make("tcpclientsrc") GstVideoReceiver.cc:739
  ├─ udp://    → gst_element_factory_make("udpsrc")       GstVideoReceiver.cc:752
  │              + caps "application/x-rtp ... H264"      GstVideoReceiver.cc:766
  ├─ udp265:// → udpsrc + caps "... H265"                 GstVideoReceiver.cc:772
  └─ mpegts:// / tcp+MPEGTS → udpsrc/tcpclientsrc → tsdemux GstVideoReceiver.cc:817-833
       ▼
[optional] rtpjitterbuffer  (inserted only if source pad caps are RTP) GstVideoReceiver.cc:836-863
       ▼
parsebin   (auto-detects & parses elementary stream — NOT hardcoded h264parse) GstVideoReceiver.cc:800
       ▼
decodebin3 (autoplugs the actual decoder — NOT hardcoded avdec_h264)   GstVideoReceiver.cc:887
       ▼
qgcvideosinkbin (QGC's custom GStreamer bin, plugin "gstqgc")          GStreamer.cc:858-895
  ├─ videoconvert / imxvideoconvert_g2d / nvvidconv (CPU path)         gstqgcvideosinkbin.cc:276-283
  ├─ glupload (GPU zero-copy path)                                    gstqgcvideosinkbin.cc:378-386
  └─ appsink ("qgcappsink")                                           gstqgcvideosinkbin.cc:289
       ▼
GstAppSinkAdapter → Qt QVideoSink                                     GStreamer.cc:869-870, 909
       ▼
QML VideoOutput (FlightDisplayViewVideoOutput.qml:6)
       ▼
Composited under FlyViewWidgetLayer (HUD) inside FlyView.qml:70-119
```

Key decision logic — `GstVideoReceiver.cc:676-680`:
```cpp
const bool isRtsp     = sourceUrl.scheme().startsWith("rtsp", ...);
const bool isUdp264    = input.contains("udp://", ...);
const bool isUdp265    = input.contains("udp265://", ...);
const bool isUdpMPEGTS = input.contains("mpegts://", ...);
const bool isTcpMPEGTS = input.contains("tcp://", ...);
```
The URI itself is produced two ways:
- **Vehicle self-reports it over MAVLink** (`VIDEO_STREAM_INFORMATION`) → `VideoManager::_updateAutoStream()` (`VideoManager.cc:596-647`) maps `VIDEO_STREAM_TYPE_RTSP/TCP_MPEG/RTPUDP/MPEG_TS` to a URI scheme.
- **User/preset-selected** → `VideoManager::_updateSettings()` (`VideoManager.cc:667-720`) maps a named source (3DR Solo, Parrot Disco, Yuneec Mantis G, Herelink Air Unit/Hotspot, or manual RTSP/UDP/TCP fields) to a hardcoded or configured URI, e.g.:
  - 3DR Solo → `udp://0.0.0.0:5600` (`VideoManager.cc:701`)
  - Parrot Disco → `udp://0.0.0.0:8888`
  - Herelink Air Unit → `rtsp://192.168.0.10:8554/H264Video`

**Recording** (separate from live display, still video-only): `_makeFileSink()` (`GstVideoReceiver.cc:894-976`) selects a muxer by format — `matroskamux`/`qtmux`/`mp4mux` (`GstVideoReceiver.h:140-143`) — and writes to `filesink`, invoked from `VideoManager::startRecording()` (`VideoManager.cc:343-372`).

---

## 4. Telemetry Data Flow (FC → HUD, step by step)

```
[Flight Controller]
       │  MAVLink v1/v2 bytes over UART/UDP/TCP/Bluetooth
       ▼
LinkInterface subclass (UDPLink/SerialLink/TCPLink/...)  — created via
  LinkConfiguration::createSettings()                     LinkConfiguration.cc:52-77
  LinkManager::createConfiguration()                      LinkManager.cc:521-530
  default autoconnect UDP port 14550                      AutoConnect.SettingsGroup.json:74-79
       ▼
LinkInterface::bytesReceived  (signal)                    LinkInterface.h:46
       │  connected in LinkManager.cc:136 to →
       ▼
MAVLinkProtocol::receiveBytes(link, data)                 MAVLinkProtocol.cc:102-145
  for each byte: mavlink_parse_char(channel, byte, &message, &status)   MAVLinkProtocol.cc:113
  on MAVLINK_FRAMING_OK → emit messageReceived
       ▼
Vehicle::_mavlinkMessageReceived(link, message)            Vehicle.cc:519-529
  (connected at Vehicle.cc:123)
       ▼
  for (FactGroup* factGroup : factGroups())
      factGroup->handleMessage(this, message);              Vehicle.cc:583-585
  switch(message.msgid) { case MAVLINK_MSG_ID_GLOBAL_POSITION_INT: ... }  Vehicle.cc:588-653
       ▼
Vehicle::_handleGlobalPositionInt()                         Vehicle.cc:859-876
  _altitudeRelativeFact.setRawValue(...)
VehicleFactGroup::_handleAttitude() / _handleAttitudeWorker() VehicleFactGroup.cc:130-144, 119-127
  roll()->setRawValue(rollDegrees); pitch()->setRawValue(...); heading()->setRawValue(...)
       ▼
QML Fact-bound property (e.g. QGCAttitudeWidget.qml:15-16, 123)
  property real _rollAngle: vehicle ? vehicle.roll.rawValue : 0
       ▼
HUD/Instrument Panel rendered in FlyViewWidgetLayer (stacked above video, see §2/§7)
```

This confirms the telemetry pipeline is entirely Fact-system-driven and has zero code dependency on the video decode path.

---

## 5. Bandwidth & Transport Analysis

- QGC does not implement any shared-link QoS/priority/bandwidth-arbitration logic between video and telemetry in the reviewed code — no rate limiter, no priority queue, no bandwidth-splitting scheme was found for either subsystem. Each is simply configured with its own address/port and opened as its own socket:
  - Telemetry: whatever `LinkConfiguration` the user set up (commonly UDP 14550, or a serial radio like a SiK/RFD900 link).
  - Video: whatever URI `VideoSettings`/auto-stream configured (commonly UDP 5600, or RTSP/TCP for higher-bitrate/companion-computer setups).
- Because they are separate sockets, if a user's hardware puts both on **one physical radio link** (e.g. a single WiFi/telemetry radio carrying both a low-rate MAVLink UDP stream and a high-rate video UDP/RTSP stream), QGC has no code-level awareness of that shared physical channel — any contention is handled entirely by the underlying network/radio hardware and OS network stack, not by QGC. This is consistent with the drone-advisor's likely underlying observation (both flows *can* ride the same physical radio), but that is a hardware/network-layer fact, not evidence they are "one stream" at the application/protocol level QGC operates on.
- RTSP gets special latency/reconnection tuning that hints at bandwidth-awareness for video specifically: `rtspsrc` is configured with 25 ms buffering latency, `do-rtcp`, a 5-second TCP timeout, UDP auto-reconnect, and 3 retries (`GstVideoReceiver.cc:722-730`), and RTSP gets a longer connection timeout than other sources to allow UDP→TCP fallback negotiation (`VideoManager.cc:839-842`, comment: *"gstreamer rtsp source will switch to tcp if udp is not available after 5 seconds"*). None of this logic touches or throttles the MAVLink telemetry link.
- No evidence of DSCP/ToS tagging, traffic shaping, or explicit bitrate negotiation for telemetry vs video was found in the searched files.

---

## 6. Telemetry-in-Video: Live display vs Recording

**`SubtitleWriter` — recording-only, confirmed by direct signal-wiring trace:**

- Construction: `_subtitleWriter(new SubtitleWriter(this))` — `VideoManager.cc:58`.
- Started **only** on the `recordingStarted` signal:
  ```cpp
  // VideoManager.cc:963-968
  connect(receiver, &VideoReceiver::recordingStarted, this, [this, receiver](const QString &filename) {
      if (!receiver->isThermal()) {
          _subtitleWriter->startCapturingTelemetry(filename, videoSize());
      }
  });
  ```
- Stopped on `recordingChanged(false)`:
  ```cpp
  // VideoManager.cc:952-961
  connect(receiver, &VideoReceiver::recordingChanged, this, [this, receiver](bool active) {
      if (!receiver->isThermal()) {
          _recording = active;
          if (!active) { _subtitleWriter->stopCapturingTelemetry(); }
          emit recordingChanged(_recording);
      }
  });
  ```
- No other call site of `SubtitleWriter`/`startCapturingTelemetry`/`stopCapturingTelemetry` exists anywhere in `src/` — confirmed by repo-wide grep. There is no connection to any live-streaming/decode-started signal.
- **What it writes:** an `.ass` (Advanced SubStation Alpha) subtitle **text sidecar file** (`SubtitleWriter.cc:54`, `.ass` extension), not KLV/binary metadata and not burned into the video frames. It samples the same `Fact`s currently shown in the on-screen telemetry bar (`HorizontalFactValueGrid`, `SubtitleWriter.cc:36-47`) once per second (`_kSampleRate = 1`, `SubtitleWriter.h:32`), formatted as `Dialogue:` lines (`SubtitleWriter.cc:102-172`).

**Conclusion: `SubtitleWriter` runs exclusively during local file recording. It is never active for live display, and it produces a separate `.ass` text file alongside the video file, not an embedded/muxed metadata track.**

**Live telemetry is always rendered by the QML overlay, never decoded from the stream** — `src/FlyView/FlyView.qml:70-119`:
```qml
70:    Item { id: mapHolder ...
86:        FlyViewVideo { id: videoControl; pipView: _pipView }
107:        FlyViewWidgetLayer {
108:            id: widgetLayer
...
115:            z: _fullItemZorder + 2
...
118:            visible: !QGroundControl.videoManager.fullScreen
119:        }
```
`FlyViewWidgetLayer` (HUD/instrument panel, joystick, etc.) is explicitly given a higher `z`-order than the video item, confirming it's a compositing overlay, not something extracted from the bitstream.

**Answer to Q4 directly: Telemetry is never embedded in the live video stream. It is always a separate QML overlay rendered on top of independently-decoded video.**

---

## 7. Single-stream multiplexing — does QGC support it?

**Partially — but not the way the advisor means.**

- QGC **does** handle MPEG-TS as a video container format: when the video URI scheme is `mpegts://` or `tcp://` (TCP-MPEG), `GstVideoReceiver::_makeSource()` explicitly inserts a **`tsdemux`** element between the source and the parser:
  ```cpp
  // GstVideoReceiver.cc:817-833
  if (isTcpMPEGTS || isUdpMPEGTS) {
      tsdemux = gst_element_factory_make("tsdemux", nullptr);
      ...
      gst_element_link(source, tsdemux);
      source = tsdemux;
  }
  ```
  This demuxer splits the MPEG-TS container into its elementary streams (video, and potentially audio) — it does **not** extract MAVLink or any telemetry metadata; QGC has zero KLV/MISB/STANAG 4609 parsing code anywhere (confirmed absent by repo-wide case-insensitive grep for `klv|misb|stanag` — zero matches).
- No RTP header-extension extraction exists either — the only pad-probe usage in the GStreamer code (`GstVideoReceiver.cc`, `GstAppSinkAdapter.cc`, `gstqgcvideosinkbin.cc`) is for internal buffer/EOS/state-change bookkeeping, never for pulling non-video payload out of the RTP stream.
- **Herelink is only a named preset URL, not special demux logic**: `videoSourceHerelinkAirUnit`/`videoSourceHerelinkHotspot` in `VideoSettings.h:63-64` simply map to fixed RTSP URLs (`rtsp://192.168.0.10:8554/H264Video`, `rtsp://192.168.43.1:8554/fpv_stream`, `VideoManager.cc:706-708`) — same generic RTSP pipeline as any other source, no vendor-specific telemetry-extraction code.
- **Conclusion: if a companion computer or Herelink-style device multiplexes MAVLink into the same MPEG-TS/UDP stream as video, QGC's `tsdemux` step would only see and demux the video (and audio) elementary streams it's configured to look for — it has no logic to pull out or hand off a separately-muxed MAVLink data PID.** In practice, such setups work with QGC by sending MAVLink over its own separate UDP port (14550-style) alongside a separate video UDP/RTSP/MPEG-TS stream — which matches the two-socket architecture documented in §2-4 — not by true single-stream demultiplexing inside QGC.

---

## 8. Source File Index

| File | Purpose |
|---|---|
| `src/VideoManager/VideoReceiver/GStreamer/GstVideoReceiver.cc/.h` | GStreamer pipeline construction: source element selection (`rtspsrc`/`udpsrc`/`tcpclientsrc`), `tsdemux` insertion for MPEG-TS, `parsebin`→`decodebin3` decode chain, recording muxer selection |
| `src/VideoManager/VideoReceiver/GStreamer/GStreamer.cc` | Creates the terminal `qgcvideosinkbin` sink and wires the `GstAppSinkAdapter` to Qt's `QVideoSink` |
| `src/VideoManager/VideoReceiver/GStreamer/gstqgc/gstqgcvideosinkbin.cc` | QGC's custom GStreamer sink bin plugin (`videoconvert`/`glupload` → `appsink`) |
| `src/VideoManager/VideoReceiver/GStreamer/GstAppSinkAdapter.cc/.h` | Bridges GStreamer `appsink` frames into Qt `QVideoSink` |
| `src/VideoManager/VideoReceiver/QtMultimedia/QtMultimediaReceiver.cc/.h` | Alternate, non-GStreamer video receiver backend (not deep-dived) |
| `src/VideoManager/VideoManager.cc/.h` | Orchestrates video source URI configuration (MAVLink auto-stream vs user preset), recording start/stop, active-vehicle camera control wiring |
| `src/VideoManager/SubtitleWriter.cc/.h` | Writes `.ass` subtitle sidecar file with sampled telemetry Facts — **recording only**, never live |
| `src/Settings/Video.SettingsGroup.json` | Video source settings/defaults, incl. default UDP `0.0.0.0:5600` |
| `src/Settings/VideoSettings.h/.cc` | Video source name constants (RTSP/UDP/TCP/MPEG-TS/Herelink/3DR Solo/Parrot Disco/Yuneec presets) |
| `src/FlyView/FlyView.qml` | Composites `FlyViewVideo` (video) and `FlyViewWidgetLayer` (HUD) as stacked, independent QML layers |
| `src/FlyView/FlightDisplayViewVideoOutput.qml` | QML `VideoOutput` sink item that renders decoded frames |
| `src/Comms/LinkConfiguration.h/.cc` | Defines the `LinkType` enum (Serial/UDP/TCP/Bluetooth/Mock/LogReplay) — no video link type |
| `src/Comms/LinkManager.cc/.h` | Creates/manages telemetry `LinkInterface` objects; wires `bytesReceived` → `MAVLinkProtocol::receiveBytes` |
| `src/Comms/MAVLinkProtocol.cc/.h` | Byte-level MAVLink parsing (`mavlink_parse_char`) |
| `src/Vehicle/Vehicle.cc/.h` | Dispatches parsed MAVLink messages to FactGroups and message-specific handlers (e.g. `GLOBAL_POSITION_INT`) |
| `src/Vehicle/FactGroups/VehicleFactGroup.cc/.h` | Handles `ATTITUDE` and other messages, updates `roll`/`pitch`/`heading` Facts consumed by the HUD |
| `src/FlightMap/Widgets/QGCAttitudeWidget.qml` | HUD attitude widget bound directly to `vehicle.roll`/`vehicle.pitch`/`vehicle.heading` Facts |
| `src/Settings/AutoConnect.SettingsGroup.json` | Default MAVLink UDP autoconnect port (14550) |

---

## Notes / limitations

- Grep-based repo-wide searches for KLV/MISB/STANAG, MPEG-TS, and RTP-header-extension logic returned zero matches outside what's cited above; absence is reported as "not found," not inferred.
- The alternate `QtMultimediaReceiver` video backend was located but not deep-dived (flagged for follow-up if needed).
- Bandwidth/QoS analysis (§5) is a negative finding — no explicit QoS code was found; this is stated as absence-of-evidence rather than proof QGC has zero bandwidth handling anywhere in the tree.
