"""Liveness/readiness state for the Python MAVLink service (Phase 5A).

Liveness = "the event loop is alive and we are not shutting down" → a failing
/healthz should make a supervisor restart the process. Readiness = "safe to
receive traffic": the telemetry publisher must be up and (after a cold-start grace
window) the publish loop must be ticking. This lets an orchestrator drain a worker
whose telemetry loop has wedged even while the HTTP server still answers.
"""
from __future__ import annotations

import time
from typing import Callable, Dict, Optional


class HealthState:
    def __init__(self, *, grace_s: float = 20.0, tick_stale_s: float = 5.0,
                 now: Optional[Callable[[], float]] = None) -> None:
        self._now = now or time.time
        self.grace_s = grace_s
        self.tick_stale_s = tick_stale_s
        self.started_at = self._now()
        self.shutting_down = False
        self.publisher_up = False
        self.last_tick_at: Optional[float] = None

    def reset_for_startup(self) -> None:
        """Clear shutdown/tick state and restart the grace window. Called at each
        lifespan startup so a re-init (e.g. a supervised restart in-process, or a
        test harness reusing the app) begins from a clean, not-shutting-down state."""
        self.started_at = self._now()
        self.shutting_down = False
        self.last_tick_at = None

    def mark_shutting_down(self) -> None:
        self.shutting_down = True

    def set_publisher_up(self, up: bool) -> None:
        self.publisher_up = bool(up)

    def record_tick(self, at: Optional[float] = None) -> None:
        self.last_tick_at = at if at is not None else self._now()

    def liveness(self) -> Dict[str, object]:
        return {
            "status": "shutting_down" if self.shutting_down else "ok",
            "uptime_s": round(self._now() - self.started_at, 1),
        }

    def readiness(self) -> Dict[str, object]:
        now = self._now()
        within_grace = (now - self.started_at) < self.grace_s
        tick_age = None if self.last_tick_at is None else now - self.last_tick_at
        tick_fresh = tick_age is not None and tick_age <= self.tick_stale_s

        checks = {
            "publisher_up": self.publisher_up,
            "tick_fresh": tick_fresh,
            "last_tick_age_s": None if tick_age is None else round(tick_age, 1),
            "within_startup_grace": within_grace,
            "shutting_down": self.shutting_down,
        }

        if self.shutting_down:
            ready = False
        elif within_grace:
            ready = self.publisher_up
        else:
            ready = self.publisher_up and tick_fresh

        return {"ready": ready, "status": "ready" if ready else "not_ready", "checks": checks}
