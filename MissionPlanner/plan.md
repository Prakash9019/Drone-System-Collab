This is the prompt, i am giving : Extract Core Logic from Mission Planner (Phase 2 Only)

I have successfully built and run Mission Planner on a Windows VM using the official repository:

https://github.com/ArduPilot/MissionPlanner

Now I am moving to Phase 2: Extracting core logic and rebuilding a modern system.

🎯 OBJECTIVE

I want to:

Understand how Mission Planner works internally
Identify the core logic (not UI, not Windows-specific parts)
Extract that logic conceptually
Rebuild it using:
Python (pymavlink) → drone communication
Node.js → API + WebSocket layer
React → UI
⚠️ IMPORTANT CONSTRAINTS
Do NOT suggest making Mission Planner cross-platform
Do NOT suggest modifying existing C# UI
Do NOT explain full repo — focus only on core functional logic
Ignore:
WinForms UI
Firmware flashing
Log analysis
Plugins
🧩 WHAT I NEED
1️⃣ FILE-TO-FILE CORE LOGIC BREAKDOWN

Explain ONLY important files related to core functionality:

MainV2.cs → what it initializes and controls
MAVLinkInterface.cs → how communication works
CurrentState.cs → how telemetry state is stored
FlightData.cs → how telemetry reaches UI
FlightPlanner.cs → how missions are handled

For each file:

What is its role?
What logic is important?
What should be extracted conceptually?
2️⃣ MAVLINK COMMUNICATION FLOW

Explain clearly:

How Mission Planner connects to drone
How MAVLink messages are read
How messages are parsed
How commands are sent

Include:

Heartbeat handling
Message loop
3️⃣ TELEMETRY PIPELINE (VERY IMPORTANT)

Explain step-by-step:

MAVLink message → parsing → state update → UI update

Which files are involved in each step?

4️⃣ STATE MANAGEMENT

Explain:

How CurrentState.cs works
How telemetry is stored
How different modules access this state
5️⃣ MISSION SYSTEM

Explain:

How waypoint missions are stored
How mission upload works
Which MAVLink messages are used
Which files handle this logic
6️⃣ MAVPROXY ROLE (CLARIFICATION)

Explain clearly:

What MAVProxy does in the ecosystem
Whether Mission Planner depends on it or not
How MAVProxy forwards MAVLink messages
7️⃣ REBUILD PLAN (MOST IMPORTANT)

Based on all above, design a clean architecture to replicate core Mission Planner functionality.

🔧 TARGET STACK
Python → MAVLink handling (pymavlink)
Node.js → API + WebSocket
React → UI
so now design a detailed plan analyse the required files and make sure u get the plan made clearly without missing any points if u have any questions ask me first refer the git hub url analyse the whole repository and then do it  

---

# Phase 2 — Mission Planner Core Logic Extraction & Rebuild Plan

This plan is based directly on the canonical files in the official **ArduPilot/MissionPlanner** repository: `MainV2.cs`, `ExtLibs/ArduPilot/Mavlink/MAVLinkInterface.cs`, `ExtLibs/ArduPilot/Mavlink/MAVState.cs` (which contains `CurrentState` references), `GCSViews/FlightData.cs`, `GCSViews/FlightPlanner.cs`, `ExtLibs/Mavlink/MavlinkParse.cs`, and `ExtLibs/SimpleExample/simpleexample.cs`. [1][2][3][4][5][6]

Total scope: ignore WinForms UI, firmware flashing, log analysis, plugins. Extract only **core functional logic**: connection, telemetry, mission, state, command.

---

## 1️⃣ File-to-File Core Logic Breakdown

### 🔹 `MainV2.cs` — Application Orchestrator
**Location:** repo root — `MainV2.cs` is ~4,800 lines and is the master controller of the application. [1]

**Role:**
- Single entry-point class (`MainV2 : Form`) that owns the global runtime state.
- Holds the **static** `comPort` field — the global `MAVLinkInterface` instance every other module talks through.
- Holds `MainV2.View` (current view), `MainV2.config` (settings), and the global `instance`.
- Spins up the **"Serial Reader" background thread** which is the heartbeat of telemetry — it loops forever calling `comPort.readPacket()` while connected. Log traces confirm its construction order: `Mainv2 ctor → Loading config → Create FD → Create FP → Create SIM → Load Plugins`. [7]
- Manages connect/disconnect button (`MenuConnect_Click`), port/baud selection, and view switching (FlightData / FlightPlanner / Setup / Config).

**Important logic to extract conceptually:**
| Concept | Why it matters |
|---|---|
| **Global connection singleton** (`comPort`) | One MAVLink session shared by all modules — replicate as a single Python service. |
| **Background read thread** | Decouples I/O from UI — replicate as a Python `asyncio` task / thread. |
| **Connect-handshake sequence** | Open port → wait for 2 heartbeats → request data streams → download params. Same logic must live in your Python layer. |
| **View lifecycle hooks** (`Activate`/`Deactivate`) | In the new stack, replaced by React component mount/unmount + WS subscribe/unsubscribe. |

**Skip:** all WinForms layout, theming, plugin loader, screen-recorder, joystick UI, splash, update checker.

---

### 🔹 `ExtLibs/ArduPilot/Mavlink/MAVLinkInterface.cs` — The Heart of Communication
**Location:** `ExtLibs/ArduPilot/Mavlink/MAVLinkInterface.cs`. The file's own header literally says: *"No Mavlink Heartbeat Packets where read from this port — Mission Planner waits for 2 valid heartbeat packets before connecting."* [3]

**Role:** Wraps a transport (serial/TCP/UDP via `ICommsSerial`) and provides the full MAVLink protocol stack — read, parse, send, ACK, retry, signing, multi-vehicle routing.

**Key methods to understand (and conceptually port):**
| Method | Purpose |
|---|---|
| `Open()` / `OpenBg()` | Opens the underlying stream (the stack trace from a real MP error confirms this calls `UdpSerial.Open()` then `MAVLinkInterface.OpenBg`). [8] |
| `getHeartBeat()` | Blocks until 2 valid HEARTBEATs are received → only then is the link considered "connected". |
| `getParamList()` | Bulk parameter download via `PARAM_REQUEST_LIST` + `PARAM_VALUE` stream. |
| `readPacket()` | Reads one framed MAVLink packet from the stream, validates CRC, handles MAVLink v1/v2, signing. |
| `sendPacket()` / `generatePacket()` | Frames + CRCs + sends a packet. |
| `doCommand(MAV_CMD, p1..p7)` | Sends `COMMAND_LONG`, waits for `COMMAND_ACK`, retries. |
| `setMode(mode)` | Sends `SET_MODE` / `MAV_CMD_DO_SET_MODE`. |
| `setWPCurrent`, `setWPTotal`, `setWP`, `getWPs` | Mission protocol. |
| `requestDatastream(stream_id, rate)` | Tells autopilot how often to send each telemetry group. |
| `MainLoop()` (background) | Continuously calls `readPacket` → routes to per-vehicle `MAVState`. |

**What to extract conceptually:**
1. **Two-phase connect**: open transport → wait-for-heartbeat → request streams → fetch params.
2. **Single read loop** that demultiplexes by `(sysid, compid)` into per-vehicle state.
3. **Request/response with retry** for ACK-bearing commands and mission items.
4. **Rate-controlled data streams** — the autopilot won't send telemetry until you request it.

**Skip:** firmware-uploader paths, log-download protocol, FTP, terrain push.

---

### 🔹 `ExtLibs/ArduPilot/Mavlink/MAVState.cs` (contains `CurrentState`) — Telemetry State Container
**Location:** `ExtLibs/ArduPilot/Mavlink/MAVState.cs` — 341 lines. [5]

**Role:** `MAVState` represents one connected vehicle (`sysid`/`compid`). It holds:
- `CurrentState cs` — the live telemetry snapshot (lat, lng, alt, roll, pitch, yaw, groundspeed, airspeed, battery_voltage, battery_remaining, mode, armed, gps_fix_type, satcount, ekf_status, vibrations, rc_in[1..16], servo_out[1..16], wind, throttle…).
- `param` — `Dictionary<string, MAVLinkParam>` of all autopilot parameters.
- `wps` — `Dictionary<int, mavlink_mission_item_int_t>` — the mission cache.
- `packets` — last-received raw message of every type (used for "give me the latest VFR_HUD").
- `aptype`, `cs.firmware` — vehicle type detection (Copter/Plane/Rover) derived from HEARTBEAT.

**`CurrentState.cs`** itself is the flat data class with ~150 properties and a single critical method: **`UpdateCurrentSettings(...)`** — called from the read-loop after each packet, it does a giant `switch` on `MAVLINK_MSG_ID` and updates the matching fields (e.g. `GLOBAL_POSITION_INT → lat/lng/alt/vx/vy/vz`, `ATTITUDE → roll/pitch/yaw`, `VFR_HUD → airspeed/groundspeed/throttle`, `SYS_STATUS → battery_voltage/current_battery/battery_remaining`, `GPS_RAW_INT → gps_fix_type/satcount`, `HEARTBEAT → mode/armed`).

**What to extract conceptually:**
- A **flat telemetry struct** (one object per vehicle) updated in place by the parser.
- **Derived/computed properties** (e.g. `distToWP`, `wp_dist`, `verticalspeed` low-pass filtered, `time_in_air`).
- **Per-vehicle isolation** via `(sysid, compid)` — supports multi-vehicle setups.

---

### 🔹 `GCSViews/FlightData.cs` — Telemetry → UI Bridge
**Role:** The "live flight" screen. Two key responsibilities you must conceptually replicate:

1. **`mainloop()` thread (a.k.a. update timer):** runs at ~10 Hz, reads `MainV2.comPort.MAV.cs` (the `CurrentState`), and pushes values into the HUD, map marker, gauges, tuning chart, and "Quick" tab.
2. **Command buttons:** Arm/Disarm, Takeoff, RTL, Land, Auto, Loiter, "Fly to here", Set ROI, Change Altitude, Change Speed, Restart Mission. Each is a thin wrapper over `MAVLinkInterface.doCommand(...)` or `setMode(...)`.

**What to extract:**
- The **read-state-and-broadcast** cadence (10 Hz is a good default; higher for HUD attitude).
- The **command catalog** — a finite set of high-level actions to expose as REST endpoints.

**Skip:** HUD rendering, GMap.NET map, gauge controls.

---

### 🔹 `GCSViews/FlightPlanner.cs` — Mission Editor / Uploader
**Role:** The waypoint editor screen. Core logic (extract this, drop the UI):

- **Mission list model:** `List<Locationwp>` where each `Locationwp` ≈ `{seq, frame, command, p1, p2, p3, p4, lat, lng, alt, autocontinue}` — i.e. one MAVLink `MISSION_ITEM_INT`.
- **Save/Load to file:** the human-readable `.waypoints` format (`QGC WPL 110\n` header followed by tab-separated lines).
- **Upload flow** → calls `MAVLinkInterface.setWPTotal(n)` then for each WP `setWP(item)`, ending with `MISSION_ACK`.
- **Download flow** → `MISSION_REQUEST_LIST` → loop `MISSION_REQUEST_INT` / `MISSION_ITEM_INT`.
- **Auto-grid / survey / polygon-fill** generators: produce a list of `Locationwp` from a polygon — pure math, very portable.
- **Geofence + Rally points** (similar item lists, different MAV_CMDs).

**What to extract:**
- The pure mission **data model** + serializers + the upload/download **protocol state machines**.

---

## 2️⃣ MAVLink Communication Flow

A canonical, runnable example exists in the repo: **`ExtLibs/SimpleExample/simpleexample.cs`** — it shows the entire connect → heartbeat → upload mission cycle in ~200 lines and uses `mavlink.ReadPacket(serialPort1.BaseStream)` + null/CRC validity checks. [6] Use it as your reference implementation.

### Flow (step by step)

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Open transport     → SerialPort / TcpClient / UdpClient  │
│ 2. Wait for HEARTBEAT  (≥2 valid ones, ~1 Hz)               │
│ 3. Detect sysid/compid + autopilot type from HEARTBEAT      │
│ 4. Send REQUEST_DATA_STREAM (or SET_MESSAGE_INTERVAL in v2) │
│ 5. Send PARAM_REQUEST_LIST → collect PARAM_VALUE * N        │
│ 6. Enter read-loop:                                          │
│       packet = ReadPacket(stream)                            │
│       if packet == null or bad CRC: continue                 │
│       dispatch(packet) → update CurrentState                 │
│       fire event to subscribers                              │
│ 7. Heartbeat sender thread: send HEARTBEAT (GCS) @ 1 Hz     │
│ 8. Command path: COMMAND_LONG → wait COMMAND_ACK (retry 3x) │
└─────────────────────────────────────────────────────────────┘
```

### Heartbeat handling
- **Receive:** every HEARTBEAT updates `MAV.cs.mode`, `armed` (bit `MAV_MODE_FLAG_SAFETY_ARMED` in `base_mode`), `cs.firmware` (from `autopilot`/`type`).
- **Timeout:** if no HEARTBEAT received for ~3 s → mark link as `LOST_COMMS`.
- **Send:** GCS must send its own HEARTBEAT @ 1 Hz with `type=MAV_TYPE_GCS` so the autopilot knows a GCS is alive (required for failsafe behavior).

### Message loop (parser side)
`MavlinkParse.cs` is the framer: scans byte-by-byte for the magic byte (`0xFE` v1 / `0xFD` v2), reads length, payload, CRC, signature (v2). It returns a `MAVLinkMessage` with `.msgid`, `.sysid`, `.compid`, `.data` (a typed struct). [4]

In your Python rebuild, **`pymavlink.mavutil.mavlink_connection(...)`** does exactly this — you don't need to reimplement framing.

---

## 3️⃣ Telemetry Pipeline (Step-by-Step)

```
[Autopilot] ──serial/UDP/TCP──▶ [MavlinkParse] ──▶ [MAVLinkInterface.readPacket]
        bytes                      raw frame              MAVLinkMessage
                                                              │
                                                              ▼
                                       [MAVState (per sysid/compid)]
                                                              │
                                                              ▼
                                  [CurrentState.UpdateCurrentSettings]
                                          updates lat/alt/roll/...
                                                              │
                                                              ▼
                                      [FlightData mainloop @ 10Hz]
                                          reads CurrentState
                                                              │
                                                              ▼
                                       [HUD / Map / Gauges UI]
```

| Step | File responsible |
|---|---|
| Bytes off the wire | `ExtLibs/Comms/CommsSerial.cs`, `CommsTcpSerial.cs`, `CommsUdpSerial.cs` |
| Frame & CRC | `ExtLibs/Mavlink/MavlinkParse.cs` [4] |
| Demux per-vehicle | `MAVLinkInterface.cs` (read thread) [3] |
| State write | `CurrentState.UpdateCurrentSettings` inside `MAVState.cs` [5] |
| State read & display | `GCSViews/FlightData.cs` |

---

## 4️⃣ State Management

**`CurrentState`** is the single source of truth per vehicle. Pattern:

- **Producer (single):** the read-loop thread inside `MAVLinkInterface`.
- **Consumers (many):** FlightData's UI timer, FlightPlanner's "current location" marker, tuning charts, voice/announcer, scripts.
- **Concurrency:** producer writes plain fields; consumers read them. Updates are not transactional — Mission Planner accepts brief inconsistency. Critical fields (`packets` dict, `param`) are guarded with `lock`.
- **Access pattern everywhere in the code:** `MainV2.comPort.MAV.cs.lat` (i.e. `singleton → active vehicle → CurrentState → field`).

**Replication idea for new stack:**
- One `dataclass` (`VehicleState`) per vehicle, held in a dict keyed by `sysid`.
- An `asyncio.Event` or pub/sub bus emits `state_updated` after each packet → Node.js subscribes via local socket / Redis / ZeroMQ → React subscribes via WebSocket.

---

## 5️⃣ Mission System

### Storage model
Mission = `List<Locationwp>` (renamed from `MISSION_ITEM_INT`). Each item:
```
seq, frame (MAV_FRAME_GLOBAL_RELATIVE_ALT_INT), command (MAV_CMD_NAV_WAYPOINT/...),
current, autocontinue, param1..param4, x (lat*1e7), y (lon*1e7), z (alt m), mission_type
```

### Upload protocol (Mission Microservice, MAVLink-spec)
```
GCS → Vehicle: MISSION_COUNT(n)
Vehicle → GCS: MISSION_REQUEST_INT(seq=0)
GCS → Vehicle: MISSION_ITEM_INT(seq=0, …)
…repeat seq=1..n-1…
Vehicle → GCS: MISSION_ACK(MAV_MISSION_ACCEPTED)
```
Implemented in `MAVLinkInterface.setWPTotal()` + `setWP()` in a loop with retry on each request. `simpleexample.cs` shows the minimal version. [6]

### Download protocol
```
GCS → Vehicle: MISSION_REQUEST_LIST
Vehicle → GCS: MISSION_COUNT(n)
GCS → Vehicle: MISSION_REQUEST_INT(0..n-1)
Vehicle → GCS: MISSION_ITEM_INT(...)
GCS → Vehicle: MISSION_ACK
```

### Files involved
- **Logic:** `MAVLinkInterface.cs` (`getWPs`, `setWP`, `setWPTotal`, `setWPACK`, `setWPCurrent`).
- **Editor model + file I/O:** `GCSViews/FlightPlanner.cs` (`.waypoints` format, polygon → grid, KML import).
- **Mission item type:** `ExtLibs/ArduPilot/Mavlink/Locationwp.cs` (a thin wrapper around `MISSION_ITEM_INT`).

### Key MAV_CMDs
`NAV_WAYPOINT (16)`, `NAV_LOITER_UNLIM (17)`, `NAV_LOITER_TURNS (18)`, `NAV_LOITER_TIME (19)`, `NAV_RETURN_TO_LAUNCH (20)`, `NAV_LAND (21)`, `NAV_TAKEOFF (22)`, `DO_JUMP (177)`, `DO_CHANGE_SPEED (178)`, `DO_SET_ROI (201)`.

---

## 6️⃣ MAVProxy's Role (Clarification)

**What MAVProxy is:** an independent command-line GCS / MAVLink router written in Python by the same ArduPilot ecosystem. It is **not used inside Mission Planner** — Mission Planner has its own MAVLink stack (the `MAVLinkInterface`) and talks directly to the autopilot.

**What MAVProxy does:**
1. **Connects** to one master link (e.g. serial USB to Pixhawk).
2. **Forwards** every MAVLink packet to N output endpoints (UDP/TCP) — e.g. `--out=udp:127.0.0.1:14550 --out=udp:192.168.1.10:14550`.
3. Lets multiple GCSs (Mission Planner + QGroundControl + your own app) all see the same vehicle simultaneously.
4. Provides a CLI for parameters, missions, scripts.

**Does Mission Planner depend on it?** **No.** Mission Planner connects directly. MAVProxy is only useful when you want **multiple consumers** of the same MAVLink stream. (This is implicitly confirmed in MP issues comparing the two as alternative GCS clients — e.g. parameter download speed comparisons. [9])

**For your rebuild:** you have two architectural choices:
| Option | Description | Recommendation |
|---|---|---|
| **A. Direct connect** | Python service uses `pymavlink` to open serial/UDP itself. | ✅ Best for v1 — simpler, fewer moving parts. |
| **B. Behind MAVProxy** | Run `mavproxy.py --master=… --out=udp:127.0.0.1:14550`, your Python service connects to that UDP. | Use later if you also want SITL testing or multi-GCS support. |

You'll get identical telemetry either way.

---

## 7️⃣ Rebuild Plan — Modern Stack Architecture

### High-level architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          DRONE / SITL                            │
│          (Pixhawk, Cube, ArduPilot SITL, etc.)                   │
└───────────────┬──────────────────────────────────────────────────┘
                │ MAVLink over Serial / UDP / TCP
                ▼
┌──────────────────────────────────────────────────────────────────┐
│  PYTHON  —  drone-core service     (replaces MAVLinkInterface)   │
│  • pymavlink mavutil.mavlink_connection                          │
│  • Connect manager      → /connect /disconnect                   │
│  • Read loop (asyncio)  → updates VehicleState dict              │
│  • Heartbeat sender (1 Hz)                                       │
│  • Param store          → /params                                │
│  • Mission service      → upload / download / read file          │
│  • Command service      → arm, takeoff, mode, goto, RTL, …       │
│  • Publishes events     → ZeroMQ PUB  tcp://127.0.0.1:5556       │
│  • Exposes              → HTTP REST   :5000  (FastAPI)           │
└───────────────┬──────────────────────────────────────────────────┘
                │ ZeroMQ SUB (telemetry stream) + REST (commands)
                ▼
┌──────────────────────────────────────────────────────────────────┐
│  NODE.JS  —  api-gateway service   (replaces MainV2 + Views)     │
│  • Express REST API                 (/api/*)                     │
│  • WebSocket server (ws / socket.io)                             │
│  • Subscribes to ZeroMQ telemetry → broadcasts to WS clients     │
│  • Auth, rate-limiting, multi-client fan-out                     │
│  • Mission file storage (SQLite/Postgres)                        │
│  • Static assets host for React build                            │
└───────────────┬──────────────────────────────────────────────────┘
                │ HTTP + WebSocket
                ▼
┌──────────────────────────────────────────────────────────────────┐
│  REACT  —  ground-station UI     (replaces FlightData/Planner)   │
│  • Connection panel                                              │
│  • HUD (artificial horizon, speed/alt tape) — react-three-fiber  │
│  • Map (MapLibre / Leaflet) with vehicle marker + WP editor      │
│  • Mission editor (drag waypoints → upload)                      │
│  • Parameter table                                               │
│  • Quick-action buttons (Arm, Takeoff, RTL, Land, Auto)          │
│  • Telemetry stream consumer (WebSocket → Zustand/Redux store)   │
└──────────────────────────────────────────────────────────────────┘
```

### Why three layers (and not two)?

| Layer | Justification |
|---|---|
| Python | `pymavlink` is the reference MAVLink lib — same team as ArduPilot — handles dialects, signing, v1/v2 framing. Re-implementing in JS is wasted effort. |
| Node | Gives you a clean **async fan-out** (one drone link → many browser clients), TLS, auth, REST/WS in one place. Browsers can't talk MAVLink directly. |
| React | Modern, cross-platform, hot-reload UI; replaces 4,800-line WinForms. |

---

### 7.1 Python service — module layout

```
drone-core/
├── app.py                  # FastAPI + lifespan
├── mavlink_link.py         # ← MAVLinkInterface equivalent
├── vehicle_state.py        # ← CurrentState dataclass (per-sysid)
├── mission.py              # ← FlightPlanner protocol logic
├── params.py               # ← param request / cache / set
├── commands.py             # ← arm/disarm/takeoff/mode/goto/RTL
├── telemetry_pub.py        # ZeroMQ publisher
├── routes/
│   ├── connection.py       # POST /connect, /disconnect
│   ├── telemetry.py        # GET /state (one-shot snapshot)
│   ├── mission.py          # GET/POST/PUT /mission
│   ├── params.py           # GET/PUT /params
│   └── command.py          # POST /command/{name}
└── tests/                  # use ArduPilot SITL
```

### 7.2 Mapping table — old C# → new Python

| Mission Planner (C#) | New Python equivalent |
|---|---|
| `MainV2.comPort` (singleton `MAVLinkInterface`) | `mavlink_link.LinkManager` singleton |
| `MAVLinkInterface.Open()` | `mavutil.mavlink_connection(url)` + `wait_heartbeat()` |
| `MAVLinkInterface.readPacket()` | `conn.recv_match(blocking=True)` in async loop |
| `MAVLinkInterface.sendPacket()` | `conn.mav.<msg>_send(...)` |
| `MAVLinkInterface.doCommand(cmd, p1..p7)` | `conn.mav.command_long_send(...)` + `recv_match(type='COMMAND_ACK')` |
| `MAVLinkInterface.setMode("AUTO")` | `conn.set_mode_apm("AUTO")` |
| `MAVLinkInterface.setWPTotal/setWP/getWPs` | `mission.upload(items)` / `mission.download()` |
| `MAVLinkInterface.requestDatastream()` | `conn.mav.request_data_stream_send(...)` or `MAV_CMD_SET_MESSAGE_INTERVAL` |
| `MAV.cs` (`CurrentState`) | `VehicleState` dataclass |
| `MAVState` (per sysid) | `vehicles: Dict[int, VehicleState]` |
| `Locationwp` | `MissionItem` pydantic model |
| `FlightData.mainloop` (10 Hz) | telemetry publisher coroutine `while True: await asyncio.sleep(0.1); pub.send(state)` |

### 7.3 Node.js gateway — endpoints

**REST (proxied to Python):**
- `POST /api/connect { url: "udp:127.0.0.1:14550" }`
- `POST /api/disconnect`
- `GET  /api/state`
- `GET  /api/params`
- `PUT  /api/params/:name { value }`
- `GET  /api/mission` / `PUT /api/mission { items: [...] }`
- `POST /api/command/arm | disarm | takeoff | land | rtl | mode | goto`

**WebSocket:** `ws://host/ws/telemetry`
Server pushes JSON @ 10 Hz:
```json
{"t":1714800000.123,"sysid":1,"lat":-35.36,"lng":149.16,"alt":50.2,
 "roll":0.01,"pitch":-0.02,"yaw":1.57,"groundspeed":12.3,"airspeed":12.5,
 "battery_voltage":12.4,"battery_remaining":78,"mode":"AUTO","armed":true,
 "gps_fix":3,"satcount":14,"wp_dist":42.1,"wp_no":3}
```

### 7.4 React frontend — components

```
src/
├── api/                    # axios + ws client + Zustand telemetry store
├── pages/
│   ├── Connect.tsx         # url + baud / udp port picker
│   ├── FlightData.tsx      # ← replaces FlightData.cs
│   │     ├── HUD.tsx
│   │     ├── MapView.tsx
│   │     └── QuickActions.tsx
│   ├── FlightPlanner.tsx   # ← replaces FlightPlanner.cs
│   │     ├── WaypointTable.tsx
│   │     ├── MapEditor.tsx
│   │     └── MissionToolbar.tsx
│   └── Params.tsx
└── App.tsx
```

### 7.5 Recommended build order (1–2 week sprints)

1. **Sprint 1 — link up.** Python service: connect to ArduPilot SITL over UDP, wait for heartbeat, log every message. Verify with `arducopter --console --map`.
2. **Sprint 2 — telemetry.** Build `VehicleState` and the message → state mapper (port the big `switch` from `CurrentState.UpdateCurrentSettings`). Publish via ZeroMQ + add `/state` REST.
3. **Sprint 3 — Node + WebSocket.** Stand up Express + WS, broadcast telemetry. Open a tiny React page that draws lat/alt as text — proves the pipe.
4. **Sprint 4 — commands.** Implement arm / takeoff / mode / RTL / land / goto with COMMAND_ACK retry.
5. **Sprint 5 — params.** Bulk download + edit + write-back.
6. **Sprint 6 — mission protocol.** Upload/download with retries, `.waypoints` file I/O.
7. **Sprint 7 — React HUD + map + mission editor.** Polished UI.
8. **Sprint 8 — multi-vehicle, auth, persistence, SITL CI.**

### 7.6 Testing strategy
- **ArduPilot SITL** is your loop-back drone: `sim_vehicle.py -v ArduCopter --out=udp:127.0.0.1:14550`. No hardware needed for 90 % of dev.
- Unit-test the message → state mapper with recorded `.tlog` files.
- Integration-test mission upload by reading back what you wrote.

### 7.7 Pitfalls to avoid (lessons from MP source)
- **Don't** poll the autopilot for telemetry — request data streams once, then just consume.
- **Do** send GCS HEARTBEAT @ 1 Hz or vehicle will trigger GCS-failsafe.
- **Do** key all state by `(sysid, compid)` from day one — adding multi-vehicle later is painful.
- **Do** wait for `COMMAND_ACK` before reporting success to the user — and retry the command up to 3× on timeout (this is what MP does).
- **Don't** trust the first HEARTBEAT — wait for two (this is exactly the rule MP's own error message states). [3]
- **Do** convert lat/lng using `* 1e-7` and altitudes per-frame (relative vs AMSL) — biggest source of bugs.

---

## ❓ Clarifying Questions Before We Start Building

You said to ask first if anything's unclear. Two small decisions will shape the code:

1. **Single-vehicle vs multi-vehicle from day 1?** Mission Planner supports both via `MAVState` per `(sysid, compid)`. It's much easier to design in now than retrofit. **Recommendation: design multi-vehicle, default to one.**

2. **Direct serial/UDP from Python, or always go through MAVProxy?** I recommend **direct** for v1 (one less process). Use MAVProxy only if you need to share the link with QGC/MP simultaneously.

3. **Auth model on the Node.js gateway?** None / API-key / JWT? (Affects whether the React app can be opened from a phone on the LAN.)

4. **Persistence layer needed?** SQLite for missions/params history, or filesystem `.waypoints` files only?

5. **Map provider for React?** MapLibre + OpenStreetMap (free, no key) vs Mapbox (nicer, needs key) vs Google (license cost).

If you confirm these (or say "use your defaults"), I'll produce the next deliverable: the **Python `mavlink_link.py` skeleton + `VehicleState` dataclass + the full message→state mapping table** ported one-for-one from `CurrentState.UpdateCurrentSettings`. That's the single highest-leverage piece of code in the whole rebuild.

Citations:
[1] https://github.com/ArduPilot/MissionPlanner/blob/master/MainV2.cs
[2] https://github.com/ardupilot/MissionPlanner
[3] https://github.com/ArduPilot/MissionPlanner/blob/master/ExtLibs/ArduPilot/Mavlink/MAVLinkInterface.cs
[4] https://github.com/ArduPilot/MissionPlanner/blob/master/ExtLibs/Mavlink/MavlinkParse.cs
[5] https://github.com/ArduPilot/MissionPlanner/blob/master/ExtLibs/ArduPilot/Mavlink/MAVState.cs
[6] https://github.com/ArduPilot/MissionPlanner/blob/master/ExtLibs/SimpleExample/simpleexample.cs
[7] https://github.com/ArduPilot/MissionPlanner/issues/985
[8] https://forum.modalai.com/topic/4178/ardupilot-connection-with-mission-planner
[9] https://github.com/ArduPilot/MissionPlanner/issues/2784


answers : Decisions for initial build:

Multi-vehicle support:
Design for multi-vehicle from day 1, but operate in single-vehicle mode initially. Use (sysid, compid)-based state management.
Connection approach:
Use direct MAVLink connection via Python (pymavlink) for v1. Avoid MAVProxy for now to reduce complexity. We can introduce MAVProxy later if multi-client forwarding is needed.
Authentication model:
Use a simple API-key-based authentication for now (lightweight but allows LAN/mobile access). JWT can be added later if needed.
Persistence layer:
Start with filesystem-based storage (.waypoints / JSON) for missions. Avoid database initially to keep system simple. We can introduce SQLite later for history and analytics.
Map provider:
Use MapLibre + OpenStreetMap (no API key, fully free, easier to deploy).
## 8️⃣ SUPPLEMENTARY SYSTEM LOGIC (ADDED DURING EVOLUTION)

### 8.1 Connection State Machine
- **DISCONNECTED**: Initial state. No transport open.
- **CONNECTING**: Transport open, waiting for valid HEARTBEATs (require 2).
- **ACTIVE**: Heartbeats received. Streams requested, parameters downloading.
- **LINK_LOSS**: No HEARTBEAT for > 3 seconds. GCS continues to send HEARTBEAT, but UI shows connection lost.
- **RECONNECTING**: Attempting to re-establish transport or regain HEARTBEATs.

### 8.2 MAVLink Message → State Mapping (Explicit)
- `HEARTBEAT` (0): `custom_mode` → `mode` string, `base_mode` → `armed` boolean, `autopilot` → system type.
- `SYS_STATUS` (1): `voltage_battery` → voltage, `current_battery` → current, `battery_remaining` → %.
- `GPS_RAW_INT` (24): `fix_type`, `satellites_visible`.
- `ATTITUDE` (30): `roll`, `pitch`, `yaw`.
- `GLOBAL_POSITION_INT` (33): `lat`, `lon` (scaled by 1e-7), `alt` (AMSL), `relative_alt`.
- `VFR_HUD` (74): `airspeed`, `groundspeed`, `heading`, `throttle`.

### 8.3 Command ACK + Retry Logic
- Commands (`COMMAND_LONG`) sent with a unique tracking ID or blocking call.
- Wait up to 500ms for `COMMAND_ACK`.
- If `COMMAND_ACK` not received or indicates `IN_PROGRESS`, wait/retry.
- Maximum 3 retries before returning `TIMEOUT` error to UI.

### 8.4 Telemetry Rate Control
- Upon connection, GCS sends `REQUEST_DATA_STREAM` for specific streams:
  - `MAV_DATA_STREAM_POSITION` (3 Hz)
  - `MAV_DATA_STREAM_EXTRA1` (Attitude, 10 Hz)
  - `MAV_DATA_STREAM_EXTRA2` (VFR_HUD, 5 Hz)
  - `MAV_DATA_STREAM_EXTENDED_STATUS` (SYS_STATUS, 2 Hz)

### 8.5 Error Handling Strategy
- **Transport Errors**: Auto-reconnect with exponential backoff.
- **Parser Errors**: Log invalid CRCs, discard packet, do not crash reader loop.
- **Command Failures**: Propagate `DENIED`, `UNSUPPORTED`, or `FAILED` via REST/WS to UI for user notification.

### 8.6 Video Streaming Architecture
- **Protocol**: RTSP from drone companion computer or WebRTC for low latency.
- **Backend Component**: Node.js or separate GStreamer pipeline to relay RTSP to WebRTC for browser compatibility.
- **Frontend**: WebRTC player component overlay on the HUD.
