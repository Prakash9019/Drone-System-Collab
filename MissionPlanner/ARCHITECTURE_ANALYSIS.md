# Mission Planner: Reverse Engineering & Architecture Analysis

## 🔴 WHY YOUR BINARY WON'T RUN ON macOS

**The Root Issue:** Mission Planner is built in **C# with Windows Forms** targeting **.NET Framework 4.7.2**. This is Windows-only by design.

```
Mission Planner.exe (Windows PE Binary)
↓
.NET Framework 4.7.2 (Windows-specific)
↓
Windows Forms UI (requires Windows APIs)
```

Even with Mono 6.14.1 installed, the runtime cannot find the compiled binary because:
1. The .exe was built for Windows PE format, not Mono runtime
2. You need to BUILD from source first with `dotnet build` using .NET SDK
3. macOS support is **explicitly documented as experimental and not recommended**

**README says:** *"Native MacOS and iOS support is experimental and not recommended for inexperienced users"*

---

## 1️⃣ CORE ARCHITECTURE BREAKDOWN

### **Entry Point: Program.cs**
```
Program.Main()
  ├─ Check Mono version (6+)
  ├─ Thread.CurrentThread.Name = "Base Thread"
  ├─ Application.Run(new MainV2())  ← Main Window launches
  └─ Handle SITL background processes on exit
```

### **Main Window: MainV2.cs (the Orchestrator)**

**Responsibilities:**
- Lifecycle manager (startup, shutdown)
- UI view switcher (FlightData, FlightPlanner)
- Connection management
- Thread management (serial reader, joystick, ADSB, plugins)
- Event aggregator

**Key Init Sequence:**
```csharp
public MainV2()  // Constructor
  1. Settings.LoadConfig()
  2. Theme initialization
  3. MAVLinkInterface setup (MainV2.comPort = new MAVLinkInterface())
  4. MainSwitcher view initialization
```

**Load Sequence:**
```csharp
private void MainV2_Load(OnShown)  // After UI rendered
  1. SerialReader() - Main communication thread (1ms loop)
  2. joysticksend() - Controller input thread
  3. ADSBRunner() - Aircraft detection
  4. PluginThread() - Plugin execution
  5. AutoConnect.Start() - Auto-detect serial/UDP connections
  6. Background tasks (maps, firmware, airports)
```

**Critical Thread: SerialReader()**
```csharp
async Task SerialReader()
{
    while(serialThread)  // Main loop: runs ~1000 times/second
    {
        Thread.Sleep(1);
        
        // Heartbeat/telemetry reception
        // Link quality stats
        // Speech alerts
        // Data loss detection
        // Stream rate requests
        
        UpdateConnectIcon();
        UpdateCurrentSettings(UpdateUI);  // Push state to UI
    }
}
```

---

### **MAVLink Communication: MAVLinkInterface.cs**

**Design Pattern:** Hub-and-spoke with message subscription

**Startup Flow:**
```
Open(waitForHeartbeat=true)
  ├─ Open serial/UDP connection (BaseStream.Open())
  ├─ Send heartbeat
  ├─ Wait for 2+ valid heartbeat responses (2200ms timeout)
  ├─ Extract drone type & autopilot
  ├─ Trigger OnMAVConnected events
  └─ Return if successful
```

**Message Reception Loop:**
```csharp
async Task<MAVLinkMessage> readPacketAsync()
{
    // Bytes → MAVLink frame parser
    // ~300 reads per second (1.2sec timeout per character)
    
    while(BaseStream.IsOpen)
    {
        Read header byte → Validate
        Read payload → CRC check
        Parse to MAVLinkMessage
        Dispatch via OnPacketReceived event
    }
}
```

**Message Sending:**
```csharp
void sendPacket(object indata, int sysid, int compid)
{
    // Object struct → serialize → generate packet header + CRC
    generatePacket(msgid, indata, sysid, compid)
    BaseStream.Write(buffer)
}
```

**Subscription Pattern:**
```csharp
// UI or handler subscribes to specific message types
var sub = comPort.SubscribeToPacketType(
    MAVLink.MAVLINK_MSG_ID.HEARTBEAT,
    (msg) => {
        // Handle heartbeat
        return true;  // unsubscribe if false
    }
);
```

---

## 2️⃣ STATE MANAGEMENT SYSTEM

### **CurrentState.cs - The Central Data Model**

**Purpose:** Single source of truth for all telemetry

**Structure:**
```csharp
public class CurrentState : ICloneable
{
    // Position
    public double lat, lng, altasl;
    
    // Attitude
    public float roll, pitch, yaw;
    
    // Velocity
    public double vx, vy, vz;
    public float groundspeed, airspeed;
    
    // Battery
    public double battery_voltage, battery_usedmah;
    public int battery_remaining;
    
    // Status
    public string mode;
    public bool armed, failsafe;
    public Mavlink_Sensors sensors_enabled, sensors_health, sensors_present;
    
    // Navigation
    public float wp_dist, alt_error, target_bearing;
    public float wpno;
    
    // ... 200+ more telemetry fields
}
```

**Update Flow:**
```
MAVLink message arrives
    ↓
MAVLinkInterface.OnPacketReceived event fired
    ↓
CurrentState.Parent_OnPacketReceived(message)
    ↓
Switch on message type:
    GLOBAL_POSITION_INT    → Update lat, lng, alt, velocity
    ATTITUDE              → Update roll, pitch, yaw
    VFR_HUD              → Update airspeed, groundspeed, climb
    SYS_STATUS           → Update battery, sensors, armed
    HEARTBEAT            → Update mode, armed status
    BATTERY_STATUS       → Update cell voltages
    NAV_CONTROLLER_OUTPUT → Update navigation errors
    ... 100+ more message handlers
    ↓
cs.UpdateCurrentSettings(UpdateUI)  // Push to UI every 50ms
```

**Access Pattern:**
```csharp
// UI reads current state
MainV2.comPort.MAV.cs.lat          // Current latitude
MainV2.comPort.MAV.cs.battery_voltage
MainV2.comPort.MAV.cs.armed
MainV2.comPort.MAV.cs.mode
```

---

## 3️⃣ MAVLINK COMMUNICATION FLOW

### **Telemetry Data Flow (Drone → GCS)**

```
┌─────────────┐
│   Drone     │ Sends: HEARTBEAT, GPS_RAW_INT, ATTITUDE, VFR_HUD...
│  (Ardupilot)│
└──────┬──────┘
       │ Binary MAVLink protocol
       ↓
┌──────────────────────────┐
│  Serial/UDP Connection   │ 
│  (MAVLinkInterface.      │
│   BaseStream)            │
└──────┬───────────────────┘
       │ readPacketAsync() - 1ms loop
       ↓
┌──────────────────────────┐
│  MAVLink Parser          │ Parse byte stream into structures
│  Checksum validation     │
│  Sequence number tracking│
└──────┬───────────────────┘
       │ OnPacketReceived event
       ↓
┌──────────────────────────┐
│  CurrentState Handlers   │ Switch on message type
│  Parent_OnPacketReceived │ Update 200+ telemetry fields
└──────┬───────────────────┘
       │
       ↓
┌──────────────────────────┐
│  UI Update (50ms rate)   │ Gauges, maps, graphs update
│  cs.UpdateCurrentSettings│
└──────────────────────────┘
```

### **Command Flow (GCS → Drone)**

```
User clicks "Arm" button
    ↓
doARM(sysid, compid, armit=true)
    ↓
generatePacket(COMMAND_LONG, {
    target_system: 1,
    target_component: 0,
    command: COMPONENT_ARM_DISARM,
    param1: 1.0  (arm)
})
    ↓
BaseStream.Write(mavlink_frame)  // Binary data to drone
    ↓
Wait for COMMAND_ACK response (2sec timeout)
    ↓
If ACCEPTED: UI updates armed indicator
If DENIED: Show error
```

### **Mission Upload Flow**

```
User saves mission in FlightPlanner
    ↓
savewaypoints() reads grid rows
    ↓
GetCommandList() → List<Locationwp>
    ↓
mav_mission.upload(port, sysid, compid, commandlist)
    ↓
setWPTotalAsync() → MISSION_COUNT message
    Wait for MISSION_REQUEST seq 0,1
    ↓
Loop: for each waypoint
    setWPAsync(waypoint, index)
    Send MISSION_ITEM_INT
    Wait for MISSION_ACK or MISSION_REQUEST next
    Retry on timeout
    ↓
setWPACK() → Final MISSION_ACK
    ↓
"Mission uploaded" confirmation
```

---

## 4️⃣ HEARTBEAT HANDLING (Critical!)

**Purpose:** Establishes connection and keeps it alive

**Initial Connection:**
```csharp
Open(waitForHeartbeat=true, 30sec timeout)
{
    // Send GCS heartbeat continuously
    while(timeout not reached)
    {
        sendPacket(HEARTBEAT, {
            type: MAV_TYPE.GCS,
            autopilot: MAV_AUTOPILOT.INVALID,
            mavlink_version: 3
        });
        
        // Listen for drone heartbeat (2+ required)
        if(buffer.msgid == HEARTBEAT && hb.type != MAV_TYPE.GCS)
        {
            hbhistory.Add(buffer);
            SetupMavConnect(buffer);  // Extract sysid, compid, type
        }
    }
    
    if(hbhistory.Count >= 2)
        return SUCCESS;  // Connected!
}
```

**Ongoing Keep-Alive:**
```
Every 1000ms in SerialReader():
    sendPacket(HEARTBEAT)  // Keep link alive
    Track last heartbeat time
    If > 10sec since last HB: mark link quality = 0
```

---

## 5️⃣ MISSION PLANNING SYSTEM

### **File Structure**

- **mav_mission.cs** - Mission upload/download protocol
- **missionpck.cs** - Mission binary packing (for MAVFtp)
- **FlightPlanner.cs** - UI and mission editing

### **Mission Data Model**

```csharp
public class Locationwp  // Single waypoint
{
    public ushort seq;        // Waypoint number
    public ushort id;         // MAV_CMD (WAYPOINT, LOITER, etc)
    public float lat, lng;    // Position
    public float alt;         // Altitude
    public float p1, p2, p3, p4;  // Command parameters
    public byte frame;        // MAV_FRAME (GLOBAL, RELATIVE_ALT, etc)
    public byte autocontinue;
    public byte current;
}
```

### **Mission Upload Protocol**

1. **Tell drone we're uploading:** `MISSION_COUNT` message with count
2. **Drone requests waypoints:** Sends `MISSION_REQUEST` for seq 0, 1, 2...
3. **We send waypoint:** `MISSION_ITEM_INT` with coordinates & params
4. **Retry logic:** 10 retries @ 450ms each = 4.5sec per waypoint
5. **Finish:** `MISSION_ACK` confirmation

---

## 6️⃣ MAVPROXY ROLE & ECOSYSTEM

### **What is MAVProxy?**

MAVProxy is a **middleware communication broker**, not directly part of Mission Planner.

```
┌─────────────────────────────────────┐
│          Drone/Autopilot            │
└────────────────┬────────────────────┘
                 │ MAVLink telemetry
                 ↓
    ┌────────────────────────┐
    │      MAVProxy          │
    │   (Python script)      │
    │                        │
    │  ├─ Serial receiver    │ Read from drone
    │  ├─ UDP broadcaster    │ Forward to multiple clients
    │  ├─ Command parser     │ Console commands
    │  └─ Logging            │ Record telemetry
    └────────────┬─────────────────────┬─────────────┐
                 │                     │             │
      ┌──────────↓────────┐  ┌────────↓──────┐  ┌─────↓──────┐
      │  Mission Planner  │  │ QGroundControl│  │   SITL     │
      │  (UDP localhost:  │  │   (UDP 14550) │  │  Simulator │
      │   14550)          │  │               │  │            │
      └───────────────────┘  └───────────────┘  └────────────┘
```

### **MAVProxy Usage in Mission Planner Ecosystem**

| Scenario | Uses MAVProxy? | Why |
|----------|---|---|
| Direct USB serial to drone | NO | Direct connection |
| Multiple GCS tools | YES | MAVProxy forwards to many clients (UDP) |
| High-latency links | YES | MAVProxy does forwarding/queueing |
| SITL simulation | YES | SITL sends to MAVProxy on 14550 |
| Radio module (3DR) | NO | Direct serial passthrough |

### **When NOT Used**

Mission Planner connects **directly** in most cases:
- Serial/USB to drone → MAVLinkInterface → Direct comms
- UDP to drone IP → Direct connection
- Auto-detected by CommsSerialScan

### **Key Insight**

MAVProxy is **optional infrastructure**, not core to Mission Planner's internal architecture. It's used when:
1. Need multiple GCS clients on same drone
2. Need intermediate processing
3. SITL simulation with Ardupilot

---

## 7️⃣ REBUILD PLAN: Modern Stack Implementation

### **Target Architecture**

```
                    ┌─────────────────────────────────┐
                    │     React Web Frontend          │
                    │  (Gauges, Maps, Mission Plan)   │
                    └──────────────────┬──────────────┘
                                       │ WebSocket / REST
                    ┌──────────────────↓──────────────┐
                    │    Node.js Express API          │
                    │  (State aggregation, Commands)  │
                    └──────────────────┬──────────────┘
                                       │ stdio / TCP
                    ┌──────────────────↓──────────────┐
                    │   Python MAVLink Service        │
                    │  (pymavlink, serial/UDP comms)  │
                    └──────────────────┬──────────────┘
                                       │ Binary MAVLink
                          ┌────────────↓─────────────┐
                          │    Drone / Autopilot     │
                          │  (Ardupilot, PX4, etc)   │
                          └──────────────────────────┘
```

### **Project Structure**

```
gcs-ground-control-station/
├── python-service/
│   ├── mav_service.py           # Main MAVLink handler
│   ├── mav_state.py             # Telemetry aggregator
│   ├── mav_commands.py          # Command dispatcher
│   ├── mav_missions.py          # Mission manager
│   ├── requirements.txt         # pymavlink, etc
│   └── config.yaml
│
├── node-api/
│   ├── src/
│   │   ├── app.js               # Express server
│   │   ├── services/
│   │   │   ├── mav.service.js   # Python service manager
│   │   │   ├── state.service.js # State aggregation
│   │   │   └── mission.service.js
│   │   ├── routes/
│   │   │   ├── telemetry.routes.js
│   │   │   ├── commands.routes.js
│   │   │   └── missions.routes.js
│   │   ├── websocket/
│   │   │   └── telemetry.ws.js  # Real-time pushes
│   │   └── config.js
│   ├── package.json
│   └── .env
│
├── frontend/
│   ├── public/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Dashboard/       # Main overview
│   │   │   ├── Telemetry/       # Gauges, indicators
│   │   │   ├── Map/             # Mission map
│   │   │   ├── MissionPlanner/  # Waypoint editor
│   │   │   └── Commands/        # Arm, Land, etc
│   │   ├── services/
│   │   │   ├── api.service.js   # HTTP calls
│   │   │   ├── ws.service.js    # WebSocket
│   │   │   └── state.service.js # Redux/Zustand
│   │   ├── App.jsx
│   │   └── index.jsx
│   ├── package.json
│   └── vite.config.js
│
├── docker-compose.yml           # Dev environment
└── README.md
```

### **Phase 1: Python MAVLink Bridge**

**mav_service.py** - Replaces MAVLinkInterface.cs
```python
class MAVService:
    def __init__(self, connection_string, baudrate=115200):
        # connection_string: '/dev/ttyUSB0:115200' or 'tcp:127.0.0.1:5760'
        self.mav = mavutil.mavlink_connection(connection_string, baud=baudrate)
        self.state = {}
        self.running = True
        
    def start_reader(self):
        # Equivalent to SerialReader()
        while self.running:
            msg = self.mav.recv_match(blocking=True, timeout=0.5)
            if msg:
                self._handle_message(msg)
                self._broadcast_to_nodejs()
                
    def _handle_message(self, msg):
        # Equivalent to CurrentState.Parent_OnPacketReceived
        if msg.get_type() == 'HEARTBEAT':
            self.state['armed'] = (msg.base_mode & 128) != 0
            self.state['mode'] = self._decode_mode(msg)
            
        elif msg.get_type() == 'GLOBAL_POSITION_INT':
            self.state.update({
                'lat': msg.lat / 1e7,
                'lng': msg.lon / 1e7,
                'alt_asl': msg.alt / 1000.0,
                'alt_rel': msg.relative_alt / 1000.0,
                'vx': msg.vx / 100.0,
                'vy': msg.vy / 100.0,
                'vz': msg.vz / 100.0
            })
            
    def arm(self, arm_it=True):
        # Equivalent to doARM()
        self.mav.mav.command_long_send(
            self.mav.target_system,
            self.mav.target_component,
            mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
            0,
            float(arm_it),  # 1=arm, 0=disarm
            0, 0, 0, 0, 0, 0
        )
        
    def upload_mission(self, waypoints):
        # Equivalent to mav_mission.upload()
        self.mav.mav.mission_count_send(
            self.mav.target_system,
            self.mav.target_component,
            len(waypoints),
            MAV_MISSION_TYPE_MISSION
        )
        
        for idx, wp in enumerate(waypoints):
            self.mav.mav.mission_item_int_send(
                self.mav.target_system,
                self.mav.target_component,
                idx,
                MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
                wp['command'],
                0,  # current
                1,  # autocontinue
                wp['param1'], wp['param2'], wp['param3'], wp['param4'],
                int(wp['lat'] * 1e7),
                int(wp['lng'] * 1e7),
                wp['alt'],
                MAV_MISSION_TYPE_MISSION
            )
```

### **Phase 2: Node.js API Bridge**

**app.js** - REST + WebSocket server
```javascript
const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');

const app = express();
const wss = new WebSocketServer({ port: 8080 });

// Spawn Python MAVLink service
const mavProcess = spawn('python', ['mav_service.py', '--port', '/dev/ttyUSB0']);

// Handle Python output
mavProcess.stdout.on('data', (data) => {
    const state = JSON.parse(data.toString());
    
    // Broadcast to all WebSocket clients
    wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'STATE_UPDATE', payload: state }));
        }
    });
});

// REST endpoints
app.get('/api/telemetry', (req, res) => {
    res.json({ /* current state */ });
});

app.post('/api/commands/arm', (req, res) => {
    mavProcess.stdin.write(JSON.stringify({ cmd: 'ARM', armed: true }) + '\n');
    res.json({ status: 'OK' });
});

app.post('/api/missions/upload', (req, res) => {
    const { waypoints } = req.body;
    mavProcess.stdin.write(JSON.stringify({ cmd: 'UPLOAD_MISSION', waypoints }) + '\n');
    res.json({ status: 'UPLOADING' });
});

app.listen(3000);
```

### **Phase 3: React Frontend**

**Dashboard.jsx**
```jsx
import React, { useEffect, useState } from 'react';
import { Gauge, Map, MissionPlanner } from './components';
import { useWebSocket } from './hooks/useWebSocket';

export const Dashboard = () => {
    const [state, setState] = useState({
        armed: false,
        mode: 'DISARMED',
        lat: 0, lng: 0, alt: 0,
        battery_voltage: 0,
        gpsstatus: 0
    });
    
    const ws = useWebSocket('ws://localhost:8080', (msg) => {
        if(msg.type === 'STATE_UPDATE') {
            setState(msg.payload);
        }
    });
    
    const handleArm = async () => {
        await fetch('/api/commands/arm', { 
            method: 'POST',
            body: JSON.stringify({ armed: true })
        });
    };
    
    return (
        <div className="dashboard">
            <Gauge value={state.battery_voltage} label="Battery (V)" />
            <Gauge value={state.alt} label="Altitude (m)" />
            <Map lat={state.lat} lng={state.lng} />
            <button onClick={handleArm}>
                {state.armed ? 'DISARM' : 'ARM'}
            </button>
        </div>
    );
};
```

---

## 🚀 MINIMAL WORKING IMPLEMENTATION PLAN

### **Step 1: Connect & Read Telemetry**
```python
# Week 1
from pymavlink import mavutil

conn = mavutil.mavlink_connection('/dev/ttyUSB0', baud=115200)
conn.wait_heartbeat()

while True:
    msg = conn.recv_match(blocking=True)
    print(f"{msg.get_type()}: {msg.to_dict()}")
```

**Goal:** Print heartbeat, GPS, attitude to console

### **Step 2: Send Commands**
```python
# Week 1
conn.mav.command_long_send(
    1, 0, mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
    0, 1, 0, 0, 0, 0, 0, 0  # Arm
)

msg = conn.recv_match(type='COMMAND_ACK', blocking=True)
print(f"ARM result: {msg.result}")
```

**Goal:** Arm drone from script

### **Step 3: Upload Mission**
```python
# Week 2
waypoints = [
    {'lat': 0, 'lng': 0, 'alt': 100, 'cmd': 16},  # WAYPOINT
    {'lat': 1, 'lng': 1, 'alt': 100, 'cmd': 16},
]

upload_mission(conn, waypoints)
```

**Goal:** Load mission, verify count sent

### **Step 4: Express Server**
```javascript
// Week 2
const express = require('express');
const { spawn } = require('child_process');

const mav = spawn('python', ['mav_service.py']);

app.get('/telemetry', (req, res) => {
    res.json(currentState);
});

app.post('/arm', (req, res) => {
    mav.stdin.write('ARM\n');
    res.json({ ok: true });
});
```

**Goal:** REST API serves telemetry

### **Step 5: React Dashboard**
```jsx
// Week 3
const [state, setState] = useState({});

useEffect(() => {
    const ws = new WebSocket('ws://localhost:8000');
    ws.onmessage = (e) => setState(JSON.parse(e.data));
}, []);

return <div>
    <p>Altitude: {state.alt}m</p>
    <button onClick={() => fetch('/arm')}>ARM</button>
</div>;
```

**Goal:** Real-time display, click to arm

---

## 📊 DATA FLOW COMPARISON

### **Mission Planner (C#/.NET)**
```
UI Event → MainV2 handler → MAVLinkInterface.sendPacket()
  → BaseStream.Write() → Drone
```

### **New Stack (React + Node + Python)**
```
Click button → React component → fetch('/api/commands/arm')
  → Express route → stdin to Python → pymavlink → Drone
```

### **State Update (Telemetry)**

**MP:** SerialReader() → CurrentState → UI binding (1000ms loop)

**New:** Python process → JSON stdout → Node broadcasts → WS → React setState (real-time)

---

## ⚡ KEY INSIGHTS FOR REBUILD

1. **Message subscription** (not polling) is key - implement pub/sub in Node
2. **State aggregation** must happen in Python - don't duplicate logic
3. **Retry logic** critical for commands - implement in Node service
4. **Heartbeat keep-alive** - Python background thread
5. **WebSocket for telemetry** - much better than polling
6. **Async/await** everywhere - Python asyncio + Node promises

## 8️⃣ ADVANCED ARCHITECTURE COMPONENTS (ADDED DURING EVOLUTION)

### JSON Data Schema (Backend → Frontend)
Standardized WebSocket payload:
```json
{
  "type": "TELEMETRY_UPDATE",
  "vehicle_id": 1,
  "timestamp": 1680000000.123,
  "data": {
    "position": { "lat": -35.36, "lng": 149.16, "alt_amsl": 50.2, "alt_rel": 20.1 },
    "attitude": { "roll": 0.01, "pitch": -0.02, "yaw": 1.57 },
    "velocity": { "airspeed": 12.5, "groundspeed": 12.3, "climb": 1.2 },
    "battery": { "voltage": 12.4, "current": 15.2, "remaining": 78 },
    "status": { "mode": "AUTO", "armed": true, "gps_fix": 3, "satellites": 14 }
  }
}
```

### Async/Threading Model
- **Python Service**: `asyncio` event loop. Main loop runs `conn.recv_match` in a non-blocking or threaded executor. Background asyncio tasks for 1 Hz GCS HEARTBEAT and state publishing via ZeroMQ.
- **Node API**: Event-driven Node loop. ZeroMQ subscriber runs asynchronously and fans out to WebSocket clients.

### Service Communication Flow Details
1. **Python `drone-core`** reads MAVLink, updates internal `VehicleState`.
2. Python publishes diffs or full state @ 10 Hz to `ZeroMQ PUB` (e.g., `tcp://127.0.0.1:5556`).
3. **Node.js `api-gateway`** listens on `ZeroMQ SUB`, parses JSON, forwards to all connected `ws://` clients.
4. UI commands: React `POST /api/command/arm` → Node.js Express `POST /command/arm` to Python FastAPI → Python sends `COMMAND_LONG` → Python awaits `COMMAND_ACK` → Python responds HTTP 200 → Node responds HTTP 200 → React shows success.

### Video Streaming Architecture (RTSP/WebRTC)
```
┌─────────────────┐       RTSP        ┌──────────────────────┐      WebRTC       ┌──────────────────┐
│ Drone Camera /  ├──────────────────►│ Media Relay Server   ├──────────────────►│ React Frontend   │
│ Companion PC    │                   │ (GStreamer/Mediamtx) │                   │ (WebRTC Player)  │
└─────────────────┘                   └──────────────────────┘                   └──────────────────┘
```
Video streaming operates out-of-band from MAVLink telemetry to prevent blocking the command link.
