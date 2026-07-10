"""Prometheus metrics for the Python MAVLink service (Phase 5A).

A dedicated CollectorRegistry (not the global default) holds the service's golden
signals plus the telemetry-publisher internals ops needs to watch the F5 ceiling.
Using an explicit registry keeps tests isolated (no cross-test metric bleed) and
lets the app expose exactly this set at GET /metrics.
"""
from __future__ import annotations

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram, generate_latest, CONTENT_TYPE_LATEST


class Metrics:
    def __init__(self, registry: CollectorRegistry | None = None) -> None:
        self.registry = registry or CollectorRegistry()

        self.http_requests = Counter(
            "http_requests_total", "HTTP requests handled",
            ["method", "route", "status"], registry=self.registry,
        )
        self.http_duration = Histogram(
            "http_request_duration_seconds", "HTTP request duration (s)",
            ["method", "route"],
            buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5),
            registry=self.registry,
        )
        self.telemetry_frames_published = Counter(
            "telemetry_frames_published_total", "ZMQ telemetry frames published",
            ["drone_id", "type"], registry=self.registry,
        )
        self.telemetry_publish_errors = Counter(
            "telemetry_publish_errors_total", "ZMQ publish send errors",
            registry=self.registry,
        )
        self.telemetry_tick_duration = Histogram(
            "telemetry_tick_duration_seconds", "Duration of one publish_loop tick (s)",
            buckets=(0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5),
            registry=self.registry,
        )
        self.telemetry_ticks = Counter(
            "telemetry_ticks_total", "publish_loop ticks executed",
            registry=self.registry,
        )
        self.telemetry_tick_failures = Counter(
            "telemetry_tick_failures_total", "publish_loop ticks that raised",
            registry=self.registry,
        )
        self.fleet_drones = Gauge(
            "fleet_drones", "Registered drone sessions in this worker",
            registry=self.registry,
        )
        self.fleet_drones_online = Gauge(
            "fleet_drones_online", "Drone sessions currently online",
            registry=self.registry,
        )
        self.drone_last_seen_age = Gauge(
            "drone_last_seen_age_seconds", "Seconds since last message per drone",
            ["drone_id"], registry=self.registry,
        )
        self.zmq_publisher_up = Gauge(
            "zmq_publisher_up", "1 when the ZMQ publisher socket is bound and running",
            registry=self.registry,
        )

    def expose(self) -> bytes:
        return generate_latest(self.registry)

    @property
    def content_type(self) -> str:
        return CONTENT_TYPE_LATEST


_metrics: Metrics | None = None


def get_metrics() -> Metrics:
    """Process-wide Metrics singleton (created lazily)."""
    global _metrics
    if _metrics is None:
        _metrics = Metrics()
    return _metrics
