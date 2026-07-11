import asyncio
import time
import logging
import os
import json
from typing import Dict, Set
from pymavlink import mavutil

logger = logging.getLogger(__name__)


class ParameterSyncManager:
    def __init__(self, link_manager):
        self.lm = link_manager
        self.parameters: Dict[str, float] = {}
        self.param_types: Dict[str, int] = {}
        self.received_indexes: Set[int] = set()
        self.total_reported = 0
        self.state = "IDLE"
        self.started_at = 0.0
        self.last_update = 0.0
        self.last_error = ""
        self._sync_lock = asyncio.Lock()
        self._param_waiters: Dict[str, list[asyncio.Future]] = {}
        self.cache_root = os.path.join(os.path.dirname(__file__), "param_cache")
        self.cache_max_age_s = 3600.0
        self.cache_loaded = False
        self.cache_last_loaded_at = 0.0
        self.cache_last_saved_at = 0.0
        self.cache_source = ""

    def to_status(self):
        received = len(self.received_indexes) if self.total_reported > 0 else len(self.parameters)
        progress = 0.0 if self.total_reported <= 0 else min(100.0, (received / self.total_reported) * 100.0)
        missing = 0 if self.total_reported <= 0 else max(0, self.total_reported - received)
        return {
            "state": self.state,
            "received": received,
            "reported": self.total_reported,
            "missing": missing,
            "progress_percent": round(progress, 2),
            "last_update": self.last_update,
            "last_error": self.last_error,
            "cache_loaded": self.cache_loaded,
            "cache_source": self.cache_source,
            "cache_last_loaded_at": self.cache_last_loaded_at,
            "cache_last_saved_at": self.cache_last_saved_at,
        }

    def _current_cache_key(self):
        sysid = self.lm.primary_sysid if self.lm and self.lm.primary_sysid is not None else "unknown"
        compid = self.lm.primary_compid if self.lm and self.lm.primary_compid is not None else "unknown"
        return f"{sysid}_{compid}"

    def _cache_path(self):
        os.makedirs(self.cache_root, exist_ok=True)
        return os.path.join(self.cache_root, f"{self._current_cache_key()}.json")

    def load_cache(self, max_age_s: float | None = None):
        max_age = self.cache_max_age_s if max_age_s is None else max_age_s
        path = self._cache_path()
        if not os.path.exists(path):
            return False
        try:
            mtime = os.path.getmtime(path)
            if (time.time() - mtime) > max_age:
                return False
            with open(path, "r", encoding="utf-8") as f:
                payload = json.load(f)
            self.parameters = {str(k): float(v) for k, v in payload.get("parameters", {}).items()}
            self.param_types = {str(k): int(v) for k, v in payload.get("param_types", {}).items()}
            self.total_reported = int(payload.get("total_reported", len(self.parameters)))
            self.received_indexes = set(range(min(self.total_reported, len(self.parameters))))
            self.cache_loaded = True
            self.cache_source = "disk"
            self.cache_last_loaded_at = time.time()
            self.state = "CACHE_WARM"
            return True
        except Exception as e:
            logger.warning("Failed to load parameter cache: %s", e)
            return False

    def save_cache(self):
        try:
            path = self._cache_path()
            payload = {
                "saved_at": time.time(),
                "total_reported": self.total_reported,
                "parameters": self.parameters,
                "param_types": self.param_types,
            }
            with open(path, "w", encoding="utf-8") as f:
                json.dump(payload, f)
            self.cache_last_saved_at = time.time()
            return True
        except Exception as e:
            logger.warning("Failed to save parameter cache: %s", e)
            return False

    def on_param_value(self, msg):
        param_id = msg.param_id
        if isinstance(param_id, bytes):
            param_id = param_id.decode("utf-8", errors="ignore").rstrip("\x00")
        else:
            param_id = str(param_id).rstrip("\x00")

        self.parameters[param_id] = msg.param_value
        self.param_types[param_id] = int(getattr(msg, "param_type", mavutil.mavlink.MAV_PARAM_TYPE_REAL32))
        self.total_reported = max(self.total_reported, int(getattr(msg, "param_count", 0)))

        idx = int(getattr(msg, "param_index", -1))
        if idx >= 0:
            self.received_indexes.add(idx)

        self.last_update = time.time()
        if self.last_update - self.cache_last_saved_at > 2.0:
            self.save_cache()

        waiters = self._param_waiters.get(param_id, [])
        if waiters:
            for fut in waiters:
                if not fut.done():
                    fut.set_result(msg.param_value)
            self._param_waiters[param_id] = [f for f in waiters if not f.done()]

    async def _wait_for_param_value(self, param_id: str, timeout_s: float = 0.7):
        loop = asyncio.get_event_loop()
        fut = loop.create_future()
        key = param_id.rstrip("\x00")
        self._param_waiters.setdefault(key, []).append(fut)
        try:
            return await asyncio.wait_for(fut, timeout=timeout_s)
        except asyncio.TimeoutError:
            return None
        finally:
            arr = self._param_waiters.get(key, [])
            self._param_waiters[key] = [f for f in arr if f is not fut and not f.done()]

    async def refresh_param(self, param_id: str, timeout_s: float = 1.0):
        """Re-read a single parameter by name from the vehicle and update the cache.

        Used after operations that change a param on the FC without an explicit
        PARAM_SET (e.g. MISSION_CLEAR_ALL zeroes FENCE_TOTAL), so /fence/status
        reflects reality instead of the stale cached value. Returns the fresh
        float value, or None on timeout / no connection.
        """
        if not self.lm.conn or not self.lm.primary_sysid:
            return None
        key = param_id.rstrip("\x00")
        sysid, compid = self.lm.primary_sysid, self.lm.primary_compid
        # param_index = -1 tells ArduPilot to look the parameter up by name.
        self.lm.conn.mav.param_request_read_send(sysid, compid, key.encode("utf-8"), -1)
        observed = await self._wait_for_param_value(key, timeout_s=timeout_s)
        if observed is not None:
            self.parameters[key] = float(observed)
        return observed

    async def set_parameter_verified(self, param_id: str, param_value: float, retries: int = 3, tolerance: float = 1e-5):
        """
        Writes PARAM_SET and verifies by waiting for matching PARAM_VALUE echo.
        If all retries fail and a cached old value exists, attempts rollback.
        """
        if not self.lm.conn or not self.lm.primary_sysid:
            return {"ok": False, "error": "No MAVLink session", "rolled_back": False}

        key = param_id.rstrip("\x00")
        old_value = self.parameters.get(key, None)
        param_type = self.param_types.get(key, mavutil.mavlink.MAV_PARAM_TYPE_REAL32)
        sysid, compid = self.lm.primary_sysid, self.lm.primary_compid

        for _ in range(retries):
            self.lm.conn.mav.param_set_send(
                sysid,
                compid,
                key.encode("utf-8"),
                float(param_value),
                int(param_type),
            )
            observed = await self._wait_for_param_value(key, timeout_s=0.7)
            if observed is not None and abs(float(observed) - float(param_value)) <= tolerance:
                self.parameters[key] = float(observed)
                self.save_cache()
                return {"ok": True, "error": "", "rolled_back": False, "value": float(observed)}

        # rollback semantics: best-effort restore old value if known
        rolled_back = False
        if old_value is not None:
            try:
                self.lm.conn.mav.param_set_send(
                    sysid,
                    compid,
                    key.encode("utf-8"),
                    float(old_value),
                    int(param_type),
                )
                observed = await self._wait_for_param_value(key, timeout_s=0.7)
                if observed is not None and abs(float(observed) - float(old_value)) <= tolerance:
                    self.parameters[key] = float(observed)
                    rolled_back = True
                    self.save_cache()
            except Exception:
                rolled_back = False

        self.last_error = f"PARAM_SET verify failed for {key}"
        return {"ok": False, "error": self.last_error, "rolled_back": rolled_back}

    async def fetch_all(self):
        if not self.lm.conn or not self.lm.primary_sysid:
            self.last_error = "No MAVLink session"
            return False
        if self._sync_lock.locked():
            return False

        async with self._sync_lock:
            self.state = "SYNCING"
            self.started_at = time.time()
            self.last_error = ""
            self.received_indexes.clear()
            self.total_reported = 0

            sysid, compid = self.lm.primary_sysid, self.lm.primary_compid
            self.lm.conn.mav.param_request_list_send(sysid, compid)

            deadline = time.time() + 12.0
            while time.time() < deadline:
                if self.total_reported and len(self.received_indexes) >= self.total_reported:
                    self.state = "COMPLETE"
                    self.save_cache()
                    return True
                await asyncio.sleep(0.1)

            # Missing parameter recovery by index batches
            self.state = "RECOVERING_MISSING"
            missing = [i for i in range(self.total_reported) if i not in self.received_indexes]
            for i in range(0, len(missing), 10):
                for idx in missing[i:i + 10]:
                    self.lm.conn.mav.param_request_read_send(
                        sysid, compid, b"", idx
                    )
                await asyncio.sleep(1.0)
                if self.total_reported and len(self.received_indexes) >= self.total_reported:
                    break

            if self.total_reported and len(self.received_indexes) >= self.total_reported:
                self.state = "COMPLETE"
                self.save_cache()
                return True

            self.state = "PARTIAL"
            self.last_error = "Parameter sync incomplete after recovery"
            return False
