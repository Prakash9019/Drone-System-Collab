"""Phase 5A production-hardening: configuration, structured logging, metrics, health.

These modules are intentionally dependency-light (only prometheus_client) and free
of any GStreamer/MAVLink imports, so they can be unit-tested in isolation and reused
by any worker process.
"""
from observability.config import ServiceConfig, load_config, ConfigError
from observability.health import HealthState
from observability.metrics import Metrics, get_metrics
from observability.logging_config import (
    setup_logging,
    request_id_var,
    drone_id_var,
    new_request_id,
)

__all__ = [
    "ServiceConfig",
    "load_config",
    "ConfigError",
    "HealthState",
    "Metrics",
    "get_metrics",
    "setup_logging",
    "request_id_var",
    "drone_id_var",
    "new_request_id",
]
