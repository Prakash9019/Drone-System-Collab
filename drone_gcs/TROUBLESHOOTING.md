# Troubleshooting Guide

## Understanding Your Setup

You have 3 components working together:

```
┌─────────────────┐
│  Your Drone     │
│  (Pixhawk6C)    │   ← Connected via SIYI Bluetooth
└────────┬────────┘
         │ MAVLink protocol
         │
┌────────▼──────────┐
│   MAVProxy        │   ← Forwards to UDP
│   (your laptop)   │   ← This is already RUNNING ✅
└────────┬──────────┘
         │ UDP 127.0.0.1:14550
         │
┌────────▼──────────┐      ┌──────────────────┐
│  Python Backend   │◄────►│  React Frontend  │
│  (FastAPI)        │      │  (Vite + React)  │
│  port 8000        │      │  port 3000       │
└───────────────────┘      └──────────────────┘
```

## Your Error: "POST /api/connect 500 Internal Server Error"

### Root Cause

The frontend was trying to connect to `/dev/tty.SIYI-6801129585` (serial device), but:
- The baud rate was set to `0` (invalid)
- The device might not be accessible from Python directly
- You already have MAVProxy running which is much better!

### The Fix ✅

1. **Frontend now defaults to UDP forwarding**: `udp:127.0.0.1:14550`
   - This connects to MAVProxy instead of the device directly
   - No baud rate issues

2. **Better error messages** in the backend
   - Now tells you exactly what went wrong
   - Helps diagnose "no heartbeat received"

3. **Updated UI**
   - Shows the MAVProxy command you need to run
   - Explains that it needs to be forwarding to UDP

## Testing Steps

### 1. Verify MAVProxy is working

Run this in a terminal (should already be running):
```bash
mavproxy.py \
  --master=/dev/tty.SIYI-6801129585 \
  --baudrate 115200 \
  --out udp:127.0.0.1:14550
```

You should see:
```
Detected vehicle 1:1 on link 0
online system 1
Pixhawk6C
```

✅ If you see this, MAVProxy is working!

### 2. Quick API test

From `drone_gcs/drone_core`, run:
```bash
python3 test_api.py
```

This will:
- Verify the backend API is responding
- Try to connect to the same UDP endpoint as the frontend
- Show you exactly what's happening

### 3. Try the frontend

Once both are working, go to `http://localhost:3000` and click Connect.

## Common Issues & Solutions

### Issue 1: "Connection timeout" in frontend

**Probable cause:** MAVProxy is not running or not forwarding to UDP

**Check:**
```bash
# Is MAVProxy running?
ps aux | grep mavproxy
```

If not, start it. If it is running, check the command includes:
```
--out udp:127.0.0.1:14550
```

### Issue 2: Backend won't start ("module not found")

**Fix:**
```bash
cd drone_gcs/drone_core
pip install -r requirements.txt
```

### Issue 3: Frontend won't start ("command not found: npm")

**You need to install Node.js first:**
- macOS: `brew install node`
- Linux: `sudo apt install nodejs npm`
- Windows: Download from nodejs.org

### Issue 4: "Already connected or connecting"

**This means:** You clicked Connect twice or didn't disconnect properly

**Fix:** Click "Disconnect" button or restart the backend

## Diagnostic Information to Share

If something still doesn't work, collect this info:

```bash
# 1. MAVProxy output (copy the terminal output)
# 2. Backend logs (uvicorn output)
# 3. Browser console (DevTools → Console)
# 4. Output of test_api.py
python3 drone_gcs/drone_core/test_api.py
```

Then you can see exactly where it's breaking!
