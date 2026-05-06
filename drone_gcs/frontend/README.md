# Drone GCS Frontend

Minimal React + WebSocket frontend for the drone core API. Shows live telemetry from your drone connected via MAVLink.

## Prerequisites

Before starting the frontend, ensure the backend is running:

```bash
cd drone_core
uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

## Run locally

1. Install dependencies:

```bash
cd drone_gcs/frontend
npm install
```

2. Start the dev server:

```bash
npm run dev
```

3. Open `http://localhost:3000` in your browser.

## Connection Options

The frontend supports **two connection modes**:

### Option 1: Direct Serial/Bluetooth (Recommended - MissionPlanner mode)

- **No external tools needed** — connects directly like MissionPlanner
- Select "Direct Serial/Bluetooth" radio button
- Enter device path: `/dev/tty.SIYI-6801129585`
- Set baud rate: `115200` (for SIYI devices)
- Click **Connect**

### Option 2: UDP via MAVProxy

- **Requires MAVProxy** running separately
- Select "UDP (MAVProxy)" radio button  
- Enter: `udp:127.0.0.1:14550`
- Click **Connect**
- Use this if you want multiple GCS applications

## Features

- ✅ Direct serial/Bluetooth connection (MissionPlanner-style)
- ✅ UDP forwarding via MAVProxy
- ✅ Connect/Disconnect buttons
- ✅ Live telemetry display (lat, lng, alt, speed, battery, etc.)
- ✅ Connection status and socket status
- ✅ WebSocket auto-reconnect on disconnect
- ✅ Dark theme optimized for outdoor viewing

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| "Connection timeout" (Direct) | Device not connected or wrong path | Verify device path and Bluetooth connection |
| "Connection timeout" (UDP) | MAVProxy not running | Start MAVProxy with `--out udp:127.0.0.1:14550` |
| "No telemetry received" | Backend not connected | Check backend is on port 8000 |
| "WebSocket error" | CORS issue | Ensure backend has CORS enabled |

## Development

See [SETUP.md](../SETUP.md) for complete setup guide with all components.
