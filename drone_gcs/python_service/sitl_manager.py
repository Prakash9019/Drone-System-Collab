import asyncio
import json
import logging
import os
import shutil
import signal
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

_SERVICE_DIR = Path(__file__).resolve().parent
_SIM_REL = Path("Tools") / "autotest" / "sim_vehicle.py"


def _ardupilot_root_from_sim_vehicle(script_path: str) -> Path:
    """ArduPilot repo root is parent of ``Tools`` (…/ardupilot/Tools/autotest/sim_vehicle.py)."""
    p = Path(script_path).resolve()
    if p.name != "sim_vehicle.py":
        return p.parent
    autotest = p.parent
    tools = autotest.parent
    if tools.name == "Tools":
        return tools.parent
    return autotest


def _collect_sim_vehicle_candidates(requested_cmd: str) -> list[str]:
    """Ordered search list; duplicates removed while preserving order."""
    out: list[str] = []
    seen: set[str] = set()

    def add(p: str | Path):
        s = os.path.expanduser(str(p).strip())
        if not s or s in seen:
            return
        seen.add(s)
        out.append(s)

    if requested_cmd:
        add(requested_cmd)
    add(os.environ.get("SITL_CMD", ""))
    ap_home = os.environ.get("ARDUPILOT_HOME", "").strip()
    if ap_home:
        add(Path(ap_home) / _SIM_REL)

    home = Path.home()
    for rel in (
        home / "ardupilot",
        home / "ArduPilot",
        home / "Developer" / "ardupilot",
        home / "Developer" / "ArduPilot",
        home / "developer" / "ardupilot",
        home / "code" / "ardupilot",
        home / "Code" / "ArduPilot",
        home / "src" / "ardupilot",
        home / "src" / "ArduPilot",
        home / "projects" / "ardupilot",
        home / "Projects" / "ArduPilot",
    ):
        add(rel / _SIM_REL)

    add("sim_vehicle.py")
    add(_SERVICE_DIR / "ardupilot" / _SIM_REL)
    add(Path.cwd() / "ardupilot" / _SIM_REL)
    add(Path.cwd() / "ArduPilot" / _SIM_REL)

    for depth, ancestor in enumerate(_SERVICE_DIR.parents):
        if depth > 14:
            break
        add(ancestor / "ardupilot" / _SIM_REL)
        add(ancestor / "ArduPilot" / _SIM_REL)

    return out


class SITLManager:
    def __init__(self):
        self.process = None
        self.state = "STOPPED"
        self.last_error = ""
        self.config = {}
        self._stdout_task = None
        self._stderr_task = None
        self._watchdog_task = None
        self._user_requested_stop = False
        self.log_buffer = []
        self.max_log_lines = 500
        self.profile_path = os.path.join(os.path.dirname(__file__), "sitl_profiles.json")

    def _resolve_sim_vehicle(self, requested_cmd: str = ""):
        searched: list[str] = []

        for candidate in _collect_sim_vehicle_candidates(requested_cmd):
            if not candidate:
                continue
            if os.path.isabs(candidate) or "/" in candidate or "\\" in candidate:
                searched.append(candidate)
                if os.path.isfile(candidate):
                    root = str(_ardupilot_root_from_sim_vehicle(candidate))
                    return {
                        "mode": "python_script",
                        "command": candidate,
                        "ardupilot_root": root,
                        "searched": searched,
                    }
            else:
                resolved = shutil.which(candidate)
                searched.append(candidate)
                if resolved:
                    root = str(_ardupilot_root_from_sim_vehicle(resolved))
                    return {
                        "mode": "executable",
                        "command": resolved,
                        "ardupilot_root": root,
                        "searched": searched,
                    }

        return {"mode": "missing", "command": "", "ardupilot_root": "", "searched": searched}

    def _append_mavproxy_out(self, args: list[str], extra_sim_args: list[str], append_default_out: bool) -> list[str]:
        merged = list(args)
        if extra_sim_args:
            merged.extend(extra_sim_args)
        if not append_default_out:
            return merged
        blob = " ".join(merged)
        if "--out" in blob or "--master" in blob:
            return merged
        merged.extend(["--out", "udp:127.0.0.1:14550"])
        return merged

    async def start(
        self,
        vehicle: str,
        model: str,
        home: str = "",
        wipe: bool = False,
        speedup: int = 1,
        sitl_cmd: str = "",
        extra_sim_args: list[str] | None = None,
        append_default_mavproxy_out: bool = True,
    ):
        if self.process and self.process.returncode is None:
            return {"status": "already_running"}

        resolved = self._resolve_sim_vehicle(sitl_cmd)
        if resolved["mode"] == "missing":
            self.state = "ERROR"
            self.last_error = (
                "sim_vehicle.py was not found. Fix one of: "
                "(1) Clone ArduPilot and set ARDUPILOT_HOME to the repo root, "
                "(2) Set SITL_CMD to the full path of sim_vehicle.py, "
                "(3) Paste that path in the Simulation screen field. "
                "Typical path: <ardupilot>/Tools/autotest/sim_vehicle.py. "
                f"Searched ({len(resolved['searched'])} paths): {resolved['searched'][:12]}"
                + (" …" if len(resolved["searched"]) > 12 else "")
            )
            return {"status": "failed", "error": self.last_error, "searched": resolved["searched"]}

        script = resolved["command"]
        sitl_cwd = resolved.get("ardupilot_root") or str(Path(script).resolve().parent)

        if resolved["mode"] == "python_script":
            py = sys.executable or "python3"
            args = [py, script, "-v", vehicle, "-f", model, "--no-rebuild", "--speedup", str(speedup)]
        else:
            args = [script, "-v", vehicle, "-f", model, "--no-rebuild", "--speedup", str(speedup)]

        if home:
            args.extend(["--home", home])
        if wipe:
            args.append("--wipe")

        extras = list(extra_sim_args or [])
        args = self._append_mavproxy_out(args, extras, append_default_mavproxy_out)

        kw: dict = {
            "cwd": sitl_cwd,
            "stdout": asyncio.subprocess.PIPE,
            "stderr": asyncio.subprocess.PIPE,
        }
        if sys.platform != "win32":
            kw["start_new_session"] = True

        try:
            self._user_requested_stop = False
            self.process = await asyncio.create_subprocess_exec(*args, **kw)
            self._stdout_task = asyncio.create_task(self._read_stream(self.process.stdout, "STDOUT"))
            self._stderr_task = asyncio.create_task(self._read_stream(self.process.stderr, "STDERR"))
            self._watchdog_task = asyncio.create_task(self._watch_process_exit())
            self.state = "RUNNING"
            self.last_error = ""
            self.config = {
                "vehicle": vehicle,
                "model": model,
                "home": home,
                "wipe": wipe,
                "speedup": speedup,
                "sitl_cmd": sitl_cmd or script,
                "sitl_cwd": sitl_cwd,
                "extra_sim_args": extras,
                "append_default_mavproxy_out": append_default_mavproxy_out,
                "launch_args": args,
            }
            return {"status": "started", "pid": self.process.pid, "config": self.config}
        except Exception as e:
            self.state = "ERROR"
            self.last_error = str(e)
            logger.error("Failed to start SITL: %s", e)
            return {"status": "failed", "error": str(e)}

    async def stop(self):
        if not self.process or self.process.returncode is not None:
            self.state = "STOPPED"
            return {"status": "already_stopped"}
        self._user_requested_stop = True
        if self._watchdog_task and not self._watchdog_task.done():
            self._watchdog_task.cancel()
            try:
                await self._watchdog_task
            except asyncio.CancelledError:
                pass
            self._watchdog_task = None
        try:
            if sys.platform != "win32" and hasattr(os, "killpg"):
                try:
                    pgid = os.getpgid(self.process.pid)
                    os.killpg(pgid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError, OSError):
                    self.process.send_signal(signal.SIGTERM)
            else:
                self.process.send_signal(signal.SIGTERM)
            await asyncio.wait_for(self.process.wait(), timeout=8.0)
            await self._cleanup_reader_tasks()
            self.state = "STOPPED"
            return {"status": "stopped"}
        except Exception:
            try:
                self.process.kill()
            except ProcessLookupError:
                pass
            await self.process.wait()
            await self._cleanup_reader_tasks()
            self.state = "STOPPED"
            return {"status": "killed"}

    async def reset(self):
        cfg = dict(self.config)
        await self.stop()
        if not cfg:
            return {"status": "stopped"}
        return await self.start(
            cfg.get("vehicle", "ArduCopter"),
            cfg.get("model", "quad"),
            cfg.get("home", ""),
            bool(cfg.get("wipe", False)),
            int(cfg.get("speedup", 1)),
            cfg.get("sitl_cmd", "") or "",
            cfg.get("extra_sim_args") or [],
            bool(cfg.get("append_default_mavproxy_out", True)),
        )

    def status(self):
        running = self.process is not None and self.process.returncode is None
        if not running and self.state == "RUNNING":
            self.state = "STOPPED"
        return {
            "state": self.state,
            "running": running,
            "pid": self.process.pid if running else None,
            "config": self.config,
            "last_error": self.last_error,
        }

    async def _read_stream(self, stream, source: str):
        try:
            while True:
                line = await stream.readline()
                if not line:
                    break
                decoded = line.decode(errors="ignore").rstrip()
                if decoded:
                    self.log_buffer.append(f"[{source}] {decoded}")
                    if len(self.log_buffer) > self.max_log_lines:
                        self.log_buffer = self.log_buffer[-self.max_log_lines:]
        except Exception as e:
            logger.debug("SITL log reader ended: %s", e)

    async def _watch_process_exit(self):
        if not self.process:
            return
        try:
            code = await self.process.wait()
        except asyncio.CancelledError:
            return
        if self._user_requested_stop:
            self._user_requested_stop = False
            self.state = "STOPPED"
            return
        if code not in (0, None):
            self.state = "ERROR"
            self.last_error = f"SITL process exited unexpectedly (code {code}). Check SITL logs below."
            self.log_buffer.append(f"[ORCH] Process exited with code {code}")
        else:
            self.state = "STOPPED"

    async def _cleanup_reader_tasks(self):
        for task in [self._stdout_task, self._stderr_task]:
            if task and not task.done():
                task.cancel()
        tasks = [t for t in [self._stdout_task, self._stderr_task] if t]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._stdout_task = None
        self._stderr_task = None

    def get_logs(self, limit: int = 200):
        limit = max(1, min(limit, self.max_log_lines))
        return {"lines": self.log_buffer[-limit:], "total": len(self.log_buffer)}

    def probe_sim_vehicle(self, sitl_cmd: str = "") -> dict:
        r = self._resolve_sim_vehicle(sitl_cmd)
        return {
            "found": r["mode"] != "missing",
            "script": r.get("command") or "",
            "ardupilot_root": r.get("ardupilot_root") or "",
            "searched_sample": r["searched"][:10],
            "searched_total": len(r["searched"]),
        }

    def _read_profiles(self):
        if not os.path.exists(self.profile_path):
            return {}
        try:
            with open(self.profile_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def _write_profiles(self, profiles):
        with open(self.profile_path, "w", encoding="utf-8") as f:
            json.dump(profiles, f, indent=2)

    def list_profiles(self):
        return self._read_profiles()

    def save_profile(self, name: str, config: dict):
        profiles = self._read_profiles()
        profiles[name] = config
        self._write_profiles(profiles)
        return {"status": "saved", "name": name}

    def delete_profile(self, name: str):
        profiles = self._read_profiles()
        if name in profiles:
            del profiles[name]
            self._write_profiles(profiles)
            return {"status": "deleted", "name": name}
        return {"status": "not_found", "name": name}
