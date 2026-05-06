# Direct Serial Connection (MissionPlanner Mode)

Good news: **You can now connect directly without MAVProxy** — just like MissionPlanner does.

## Why You Can Skip MAVProxy

The backend `mavlink_link.py` already supports direct serial connections using `pymavlink`, which is the same library MissionPlanner uses.

### Backend Support

The backend automatically detects the connection type:

```python
if connection_string.startswith("serial:"):
    # Direct serial/Bluetooth connection
    return mavutil.mavlink_connection(port, baud=baud, ...)

if connection_string.startswith("udp:"):
    # UDP forwarding (MAVProxy)
    return mavutil.mavlink_connection(connection_string, ...)
```

### How to Use in Frontend

1. Select **"Direct Serial/Bluetooth"** radio button
2. Enter your device path: `/dev/tty.SIYI-6801129585`
3. Set baud rate: `115200` (for SIYI)
4. Click **Connect**

The frontend will send `serial:/dev/tty.SIYI-6801129585` to the backend, and it will connect directly.

## Architecture Comparison

### MissionPlanner (Windows) → Your System (Simplified)

| Component | MissionPlanner | Your System |
|-----------|----------------|------------|
| **Connection** | Direct to COM port | Direct to `/dev/tty.SIYI-*` |
| **Protocol** | MAVLink + pymavlink | MAVLink + pymavlink ✅ |
| **UI** | WinForms | React ✅ |
| **Telemetry** | In-memory state | WebSocket to frontend ✅ |
| **Latency** | ~10ms | ~100ms (WebSocket overhead) |

## When to Use Each Mode

### Direct Serial ✅ Recommended

```
Drone → Bluetooth → Your Laptop → API → WebSocket → Browser
```

- **Pros:** Simpler, fewer dependencies, direct control
- **Cons:** Only one GCS application can connect
- **Use:** Single drone operations, local development

### UDP (MAVProxy)

```
Drone → Bluetooth → MAVProxy → UDP → API → WebSocket → Browser
        +→ Other GCS apps
```

- **Pros:** Multiple GCS apps can connect simultaneously
- **Cons:** Extra hop, requires MAVProxy running
- **Use:** Multi-GCS setup, research/testing

## Testing Direct Connection

### 1. Test directly via test_api.py

```bash
cd drone_gcs/drone_core
python3 test_api.py
```

This will test both modes and show results.

### 2. Manual test with curl

```bash
curl -X POST http://localhost:8000/api/connect \
  -H "Content-Type: application/json" \
  -d '{
    "url": "serial:/dev/tty.SIYI-6801129585",
    "baud": 115200
  }'
```

Expected response on success:
```json
{"status": "connected", "sysid": 1, "compid": 1}
```

## Compatibility Matrix

| Device | Connection String | Baud Rate |
|--------|-------------------|-----------|
| SIYI Bluetooth | `serial:/dev/tty.SIYI-6801129585` | `115200` |
| Serial USB | `serial:/dev/ttyUSB0` | `57600` or `115200` |
| Windows COM | `serial:COM3` | `57600` or `115200` |
| Network UDP | `udp:127.0.0.1:14550` | N/A (ignored) |
| Network TCP | `tcp:192.168.1.100:14550` | N/A (ignored) |

## You're Good to Go! 🚀

Just use the frontend with **"Direct Serial/Bluetooth"** mode and you're set.

MAVProxy is completely optional now.
