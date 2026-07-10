"""Configuration loading + validation for the Python MAVLink service (Phase 5A).

`load_config` reads the process environment, validates every field, and raises
`ConfigError` listing *all* problems at once so the service fails fast at boot
instead of, say, binding a ZMQ socket on a port that was mistyped as "55x6".
It is pure (takes an env dict) so it is unit-testable.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Dict, List, Mapping, Optional

_LOG_LEVELS = ("debug", "info", "warning", "error")


class ConfigError(ValueError):
    """Raised at startup when the environment is invalid. Carries all errors."""

    def __init__(self, errors: List[str]) -> None:
        self.errors = errors
        super().__init__("; ".join(errors))


def _as_int(env: Mapping[str, str], key: str, default: int, errors: List[str],
            *, minimum: Optional[int] = None, maximum: Optional[int] = None) -> int:
    raw = env.get(key)
    if raw is None or raw == "":
        val = default
    else:
        try:
            val = int(raw)
        except (TypeError, ValueError):
            errors.append(f"{key} must be an integer (got {raw!r})")
            return default
    if minimum is not None and val < minimum:
        errors.append(f"{key} must be >= {minimum} (got {val})")
    if maximum is not None and val > maximum:
        errors.append(f"{key} must be <= {maximum} (got {val})")
    return val


def _as_bool(env: Mapping[str, str], key: str, default: bool, errors: List[str]) -> bool:
    raw = env.get(key)
    if raw is None or raw == "":
        return default
    s = str(raw).strip().lower()
    if s in ("1", "true", "yes", "on"):
        return True
    if s in ("0", "false", "no", "off"):
        return False
    errors.append(f"{key} must be a boolean (got {raw!r})")
    return default


@dataclass(frozen=True)
class ServiceConfig:
    connection_string: str
    baudrate: int
    udp_forwarding_endpoints: List[str]
    drone_name: str
    http_port: int
    zmq_port: int
    log_level: str
    telemetry_hz: float
    zmq_send_max_retries: int
    zmq_send_backoff_ms: int
    readiness_grace_s: float
    metrics_enabled: bool

    def to_public_dict(self) -> Dict[str, object]:
        """Safe-to-log view (no secrets in this service, but keep the habit)."""
        return {
            "connection_string": self.connection_string,
            "baudrate": self.baudrate,
            "drone_name": self.drone_name,
            "http_port": self.http_port,
            "zmq_port": self.zmq_port,
            "log_level": self.log_level,
            "telemetry_hz": self.telemetry_hz,
            "metrics_enabled": self.metrics_enabled,
        }


def load_config(env: Optional[Mapping[str, str]] = None) -> ServiceConfig:
    """Validate and build a ServiceConfig. Raises ConfigError with all problems."""
    if env is None:
        env = os.environ
    errors: List[str] = []

    connection_string = (env.get("DRONE_CONNECTION_STRING") or "auto").strip()
    if not connection_string:
        errors.append("DRONE_CONNECTION_STRING must not be empty")

    baudrate = _as_int(env, "DRONE_BAUDRATE", 115200, errors, minimum=1200, maximum=4_000_000)

    fwd = (env.get("DRONE_UDP_FORWARD") or "").strip()
    udp_endpoints = [x.strip() for x in fwd.split(",") if x.strip()]

    drone_name = (env.get("DRONE_NAME") or "default").strip() or "default"

    http_port = _as_int(env, "PYTHON_HTTP_PORT", 8000, errors, minimum=1, maximum=65535)
    zmq_port = _as_int(env, "ZMQ_PUB_PORT", 5556, errors, minimum=1, maximum=65535)

    log_level = (env.get("LOG_LEVEL") or "info").strip().lower()
    if log_level == "warn":
        log_level = "warning"
    if log_level not in _LOG_LEVELS:
        errors.append(f"LOG_LEVEL must be one of {'|'.join(_LOG_LEVELS)} (got {env.get('LOG_LEVEL')!r})")

    telemetry_hz_raw = env.get("TELEMETRY_HZ")
    telemetry_hz = 10.0
    if telemetry_hz_raw not in (None, ""):
        try:
            telemetry_hz = float(telemetry_hz_raw)
        except (TypeError, ValueError):
            errors.append(f"TELEMETRY_HZ must be a number (got {telemetry_hz_raw!r})")
    if telemetry_hz <= 0 or telemetry_hz > 100:
        errors.append(f"TELEMETRY_HZ must be in (0, 100] (got {telemetry_hz})")

    zmq_send_max_retries = _as_int(env, "ZMQ_SEND_MAX_RETRIES", 3, errors, minimum=0, maximum=20)
    zmq_send_backoff_ms = _as_int(env, "ZMQ_SEND_BACKOFF_MS", 50, errors, minimum=1, maximum=10000)

    readiness_grace_raw = env.get("READINESS_GRACE_S")
    readiness_grace_s = 20.0
    if readiness_grace_raw not in (None, ""):
        try:
            readiness_grace_s = float(readiness_grace_raw)
        except (TypeError, ValueError):
            errors.append(f"READINESS_GRACE_S must be a number (got {readiness_grace_raw!r})")
    if readiness_grace_s < 0:
        errors.append(f"READINESS_GRACE_S must be >= 0 (got {readiness_grace_s})")

    metrics_enabled = _as_bool(env, "METRICS_ENABLED", True, errors)

    if errors:
        raise ConfigError(errors)

    return ServiceConfig(
        connection_string=connection_string,
        baudrate=baudrate,
        udp_forwarding_endpoints=udp_endpoints,
        drone_name=drone_name,
        http_port=http_port,
        zmq_port=zmq_port,
        log_level=log_level,
        telemetry_hz=telemetry_hz,
        zmq_send_max_retries=zmq_send_max_retries,
        zmq_send_backoff_ms=zmq_send_backoff_ms,
        readiness_grace_s=readiness_grace_s,
        metrics_enabled=metrics_enabled,
    )
