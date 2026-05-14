# Mission Planner HUD — Architecture

This document describes the **Mission Planner desktop (C# WinForms) HUD** only. It does not cover the separate React `AdvancedHUD` in `drone_gcs`.

## 1. Related source files

| Layer | Path |
|--------|------|
| Core control | `MissionPlanner/ExtLibs/Controls/HUD.cs` — `HUD` (OpenGL + GDI+), `HUD2` (Skia off-screen) |
| Strings / icons | `MissionPlanner/ExtLibs/Controls/HUDT.Designer.cs` |
| Flight Data host | `MissionPlanner/GCSViews/FlightData.cs` |
| WinForms bindings | `MissionPlanner/GCSViews/FlightData.Designer.cs` (`bindingSourceHud`, `hud1.DataBindings`) |
| Telemetry model | `MissionPlanner/ExtLibs/ArduPilot/CurrentState.cs` |
| MAV state wrapper | `MissionPlanner/ExtLibs/ArduPilot/Mavlink/MAVState.cs` (`MAV.cs`) |
| Platform forks | `MissionPlanner/ExtLibs/wasm/Controls/HUD.cs`, `MissionPlanner/ExtLibs/Xamarin/Xamarin/Controls/HUD.cs` |
| Other HUD hosts | `MissionPlanner/Controls/OSDVideo.Designer.cs`, `MissionPlanner/hud.html` (secondary) |

## 2. Component relationships

- **FlightData** owns `hud1` (static alias `myhud`), applies theme, settings, custom user items, optional video `bgimage`, and runs **mainloop** on a worker thread.
- **bindingSourceHud** has `DataSource = typeof(CurrentState)` and is refreshed from `MainV2.comPort.MAV.cs` (~10 Hz) on the UI thread.
- **HUD** is a `GLControl` subclass: default path uses **OpenTK**; fallback uses a **GDI+** bitmap (`objBitmap` + `GdiGraphics`). **HUD2** forces Skia over locked bitmap bits.

## 3. Rendering pipeline

1. **Triggers:** WinForms `Invalidate()` (most bound properties call it when values change), layout, theme, `bgimage` updates, or explicit `Refresh()` (e.g. HUD dropout window).
2. **Paint entry:** `HUD.OnPaint` — design mode uses GDI snapshot path; runtime requires `started` after `OnLoad`.
3. **Throttle:** If there is **no** camera `bgimage`, paints closer than **~30 ms** may return early to limit CPU.
4. **Reentrancy:** A flag `inOnPaint` + lock skips overlapping paint calls.
5. **OpenGL path:** `GL.Clear`, periodic `MakeCurrent`, then **`doPaint()`** using methods on `HUD` itself (`graphicsObject = this`) that dispatch to OpenGL or GDI per primitive.
6. **GDI path:** `doPaint()` draws into `objBitmap` via `graphicsObjectGDIP`; `OnPaint` copies with `DrawImageUnscaled`.
7. **HUD2 path:** Skia surface over bitmap, `graphicsObjectGDIP = new SkiaGraphics(surface)`, `doPaint()`, flush.
8. **End:** OpenGL calls `SwapBuffers()` and releases context.

**`doPaint()`** is the single monolithic draw routine: clear → optional full-frame `bgimage` → artificial horizon → optional roll/pitch ladder → heading strip → speed/alt tapes → battery → GPS → custom user items → armed/disarmed / safety → failsafe banner → severity-colored `messageHigh` → vibe → CPU load → EKF → prearm → optional JPEG stream (`streamjpg`).

## 4. Artificial horizon geometry

Coordinate origin for the horizon block: **center of the control** (`TranslateTransform(Width/2, Height/2)`).

- **Roll:** `RotateTransform(-roll)` for the sky/ground region (non-Russian). **Russian** mode negates roll for the sky/ground block instead of using that rotate on the first block.
- **Degrees to pixels:** `every5deg = -Height / 65` (negative ties screen Y to pitch-up).
- **Pitch offset:** `pitchoffset = -pitch * every5deg` — vertical shift of the horizon line and sky/ground split.
- **Sky:** Rectangle above the horizon line (`y` from `-halfheight*2` through `pitchoffset`).
- **Ground:** Rectangle from `pitchoffset` downward.
- **Horizon line:** Horizontal line at `y = pitchoffset` in the rotated frame.
- **NaN:** If roll, pitch, or heading is NaN, they are forced to zero for drawing and a **NaN Error** label is shown later.

Roll/pitch **ladder** (when `displayrollpitch`): clip band, re-translate to center, rotate by `-roll`, draw pitch lines every 5° (with labels every 10°), roll pointer polygon, roll arc, then fixed aircraft reference (wings) at center.

## 5. Pitch / roll / yaw on the HUD

| Display | Bound state | MAVLink source (via `CurrentState`) |
|---------|-------------|-------------------------------------|
| Horizon + ladder | `roll`, `pitch` | `ATTITUDE` (rad → deg) |
| Heading tape | `heading` | `yaw` from `ATTITUDE` |
| Target heading ticks | `targetheading` | `nav_bearing` from `NAV_CONTROLLER_OUTPUT` |
| Ground course tick | `groundcourse` | `GPS_RAW_INT` / other position paths |

Property setters on `HUD` (e.g. `roll`, `pitch`, `heading`) call **`Invalidate()`** when the value changes, so redraws follow binding updates.

## 6. EKF, GPS, failsafe, prearm (HUD drawing vs upstream logic)

**GPS (`displaygps`):** For each of `gpsfix`, `gpsfix2` (from `gpsstatus`, `gpsstatus2`), maps fix type 0–6 to `HUDT` strings and optional wide icons; red styling for no fix / no GPS; second GPS hidden if fix is 0.

**EKF (`displayekf`):** The HUD uses a **scalar** `ekfstatus` already computed in `CurrentState` from `EKF_STATUS_REPORT` (max of variances + flag-based forced “bad”). HUD thresholds: `> 0.8` → red, `> 0.5` → orange/amber, else OK (green/text). Pluggable `CustomEkfRenderer`. Click region `ekfhitzone` fires `ekfclick`.

**Failsafe:** Boolean from `CurrentState` (`HEARTBEAT`: `system_status == MAV_STATE.CRITICAL`, plus high-latency paths). HUD draws large red **FAILSAFE** text when true.

**Prearm (`displayprearm`, disarmed only):** `prearmstatus` is a **computed** `CurrentState` property from `SYS_STATUS` sensor bitmasks (`connected && (sensors_health.prearm || !sensors_enabled.prearm)`). HUD shows Ready / Not Ready text or icons; `prearmhitzone` for `prearmclick`.

**Vibration / CPU:** Optional `displayvibe` compares `vibex/y/z` thresholds; `load == 100` shows CPU hint — separate from EKF/GPS.

## 7. Update loop architecture (host, not MAV parser)

- **`FlightData.mainloop`:** Background `while (threadrun)`; typically **~50 ms** sleep when not in special log modes; calls **`updateBindingSource()`** each pass (also when `giveComport`).
- **`updateBindingSource`:** Gate of **100 ms** (`lastscreenupdate`) to cap binding refresh ~**10 Hz**; `BeginInvokeIfRequired` → **`updateBindingSourceWork`** on UI thread; lock/counter drops work if the UI queue is backed up.
- **`updateBindingSourceWork`:** `bindingSourceHud.UpdateDataSource(MainV2.comPort.MAV.cs)` (and other tab sources); HUD bindings push into `HUD` properties → **`Invalidate()`** → paint when the message pump runs.

MAVLink parsing updates **`CurrentState`** on the link thread independently; the HUD only sees snapshots through **`bindingSourceHud`**.

## 8. Feature flags (representative)

- `opengl` — OpenTK vs GDI bitmap path (auto-disabled on some failures).
- `displayrollpitch`, `displayheading`, `displayspeed`, `displayalt`, `displaygps`, `displayekf`, `displayprearm`, `displayvibe`, `displayconninfo`, `displayxtrack`, `displayAOASSA`, `displayicons`, `bgon`, `hudon`, `batteryon` / `batteryon2`, `streamjpgenable`, `Russian`, `SixteenXNine`, `HoldInvalidation`.

## 9. Reusable core vs UI-specific

**Reusable (portable concepts / math):**

- Horizon math: center translate, roll rotation, pitch-to-pixel scale, split sky/ground.
- EKF aggregation rules in `CurrentState` (variances + bitmask interpretation).
- GPS fix type → label/icon mapping tables.

**UI-specific (WinForms / OpenTK / Skia / assets):**

- `BindingSource`, `DataBindings`, `Invalidate` / `OnPaint` integration.
- `GLControl`, OpenTK immediate-mode-style helpers, `GdiGraphics`, Skia `HUD2`.
- `HUDT` resources, hit rectangles, cursors, theme hooks in `FlightData`, GStreamer `bgimage`, AVI `streamjpg`, HUD dropout window.

---

*Generated for architecture reference; does not modify Mission Planner or GCS code.*
