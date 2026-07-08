# Drone GCS - Complete Setup Guide

## Prerequisites

You need:
- **Python 3.8+** for the backend
- **Node.js + npm** for the frontend
- The frontend and backend should run simultaneously

### Optional: MAVProxy

You can either:
- **Option A:** Connect directly to your drone via serial/Bluetooth (like MissionPlanner) — **no MAVProxy needed**
- **Option B:** Use MAVProxy as a forwarding bridge

### Optional: Video subsystem (GStreamer)

The `/video` tab streams the drone's RTSP / UDP-RTP / TCP-MPEG-TS feed to the browser over WebRTC. It needs GStreamer ≥ 1.20 with the `webrtcbin` plugin **and** the Python bindings on the backend host.

**macOS:**
```bash
brew install gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly gst-libav pygobject3
```

**Ubuntu / Debian:**
```bash
sudo apt install -y gstreamer1.0-tools gstreamer1.0-plugins-{base,good,bad,ugly} \
                    gstreamer1.0-libav python3-gi python3-gst-1.0 \
                    gir1.2-gst-plugins-bad-1.0
```

**Verify:** `gst-inspect-1.0 webrtcbin` should print plugin details. If `webrtcbin` is missing, the `/video` tab will surface the error in its status banner — every other tab keeps working since the import is lazy.

---

## Setup

### Step 1: Start the Python Backend

In a terminal, navigate to the backend:


cd "/Users/suryprakash/Drone System Collab/drone_gcs/python_service"
source venv/bin/activate
python main.py

Terminal 2 — Node API gateway (port 8080)
cd "/Users/suryprakash/Drone System Collab/drone_gcs/node_api"
npm start

Terminal 3 — Frontend (port 5173)
cd "/Users/suryprakash/Drone System Collab/drone_gcs/frontend"
npm run dev

```bash
cd drone_gcs/drone_core
pip install -r requirements.txt
uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

**Expected output:**
```
INFO:     Started server process
INFO:     Uvicorn running on http://0.0.0.0:8000
```

✅ Backend is ready at `http://localhost:8000`

---

### Step 2: Start the React Frontend

In another terminal, navigate to the frontend:

```bash
cd drone_gcs/frontend
npm install
npm run dev
```

**Expected output:**
```
VITE v... ready in ... ms
➜  Local:   http://localhost:3000
```

✅ Frontend is ready at `http://localhost:3000`

---

### Step 3: Connect from the Frontend

Open `http://localhost:3000` in your browser.

#### **Option A: Direct Serial/Bluetooth (Recommended - No MAVProxy needed)**

1. Select **"Direct Serial/Bluetooth"** radio button
2. Enter your device path: `/dev/tty.SIYI-6801129585`
3. Set baud rate: `115200` (for SIYI devices)
4. Click **Connect**

This works exactly like MissionPlanner — direct connection to your drone!

#### **Option B: UDP (MAVProxy Bridge)**

1. First, start MAVProxy in another terminal:

```bash
mavproxy.py \
  --master=/dev/tty.SIYI-6801129585 \
  --baudrate 115200 \
  --out udp:127.0.0.1:14550
```

2. Select **"UDP (MAVProxy)"** radio button
3. Enter: `udp:127.0.0.1:14550`
4. Click **Connect**

This is useful if you want multiple GCS applications connected to the same drone.

---

## Connection Architecture

### Option A: Direct Serial (Simpler)

```
┌──────────────┐
│  Your Drone  │
└───────┬──────┘
        │ (MAVLink via SIYI Bluetooth)
        │
┌───────▼──────────────┐     ┌──────────────┐
│  Python Backend      │◄───►│  React UI    │
│  (FastAPI)           │     │  (Vite)      │
│  :8000               │     │  :3000       │
└──────────────────────┘     └──────────────┘
```

### Option B: With MAVProxy (For multi-client)

```
┌──────────────┐
│  Your Drone  │
└───────┬──────┘
        │ (MAVLink via SIYI Bluetooth)
        │
┌───────▼──────────────┐
│   MAVProxy           │
│ (on your laptop)     │
└───────┬──────────────┘
        │ UDP 127.0.0.1:14550
        │
┌───────▼──────────────┐     ┌──────────────┐
│  Python Backend      │◄───►│  React UI    │
│  (FastAPI)           │     │  (Vite)      │
│  :8000               │     │  :3000       │
└──────────────────────┘     └──────────────┘
```

---

## Troubleshooting

### "Connection timeout" error

**Cause:** Cannot connect to the drone

**Fix for Direct Serial:**
1. Verify the device path is correct
2. Check baud rate matches your device (115200 for SIYI, 57600 for others)
3. Ensure the Bluetooth device is connected to your laptop
4. Try: `ls /dev/tty.* | grep -i siyi`

**Fix for MAVProxy:**
1. Verify MAVProxy is running
2. Check the command includes `--out udp:127.0.0.1:14550`

### "Heartbeat timeout" error

**Cause:** The autopilot is not sending heartbeats

**Fix:**
1. Check that the drone is powered on
2. Verify the Pixhawk6C is responding in MAVProxy output (if using that mode)
3. Try restarting the connection

### Frontend shows "No telemetry received yet"

**Cause:** WebSocket is not connected or backend not running

**Fix:**
1. Check backend is running on port 8000
2. Open browser DevTools → Network → WS to verify the WebSocket connection
3. Ensure CORS is enabled (should be automatic)

---

## Quick Test

Verify everything is working:

```bash
cd drone_gcs/drone_core
python3 test_api.py
```

This will:
- Check if backend is running
- Try direct serial connection
- Try UDP connection (if MAVProxy available)
- Show diagnostics

---

## API Endpoints (for developers)

### Connection

- `POST /api/connect` — Connect to drone via MAVLink
- `POST /api/disconnect` — Disconnect from drone
- `GET /api/state` — Get current vehicle state
- `POST /api/command` — Send a MAVLink command

### Mission

- `GET /api/mission/download` — Download mission from drone
- `POST /api/mission/upload` — Upload mission to drone
- `POST /api/mission/import` — Import `.waypoints` file
- `POST /api/mission/export` — Export mission to `.waypoints` file

### WebSocket

- `ws://localhost:8000/ws/telemetry` — Live telemetry stream (10 Hz)

---

## Next Steps

- Add a HUD (horizon indicator, altitude, etc.) to the React UI
- Add a map to show drone location
- Add mission editor UI
- Add arm/disarm/takeoff buttons
