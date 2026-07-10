"""Phase 5A production-hardening tests (Python tier).

Covers config validation, structured JSON logging with correlation IDs, health/
readiness state, Prometheus metrics, the resilient ZMQ send/publish loop, and the
live /healthz /readyz /metrics endpoints — plus a backward-compat assertion that
a legacy route still answers.
"""
from __future__ import annotations

import json
import logging

import pytest

from observability.config import load_config, ConfigError
from observability.health import HealthState
from observability.metrics import Metrics
from observability.logging_config import JsonFormatter, request_id_var, drone_id_var


# ── config ─────────────────────────────────────────────────────────────────────

def test_config_defaults_valid_with_empty_env():
    cfg = load_config({})
    assert cfg.http_port == 8000
    assert cfg.zmq_port == 5556
    assert cfg.baudrate == 115200
    assert cfg.log_level == "info"
    assert cfg.metrics_enabled is True


def test_config_rejects_bad_values_all_at_once():
    with pytest.raises(ConfigError) as ei:
        load_config({
            "DRONE_BAUDRATE": "abc",
            "ZMQ_PUB_PORT": "70000",
            "LOG_LEVEL": "chatty",
            "TELEMETRY_HZ": "0",
        })
    errs = " ".join(ei.value.errors)
    assert "DRONE_BAUDRATE" in errs
    assert "ZMQ_PUB_PORT" in errs
    assert "LOG_LEVEL" in errs
    assert "TELEMETRY_HZ" in errs


def test_config_normalizes_warn_to_warning_and_parses_udp_list():
    cfg = load_config({"LOG_LEVEL": "warn", "DRONE_UDP_FORWARD": "127.0.0.1:14550, 127.0.0.1:14551"})
    assert cfg.log_level == "warning"
    assert cfg.udp_forwarding_endpoints == ["127.0.0.1:14550", "127.0.0.1:14551"]


# ── structured logging ─────────────────────────────────────────────────────────

def test_json_formatter_emits_object_with_context():
    fmt = JsonFormatter(service="test-svc")
    rid_token = request_id_var.set("req-7")
    did_token = drone_id_var.set("scout-1")
    try:
        rec = logging.LogRecord("t", logging.INFO, __file__, 1, "hello", None, None)
        rec.custom_field = "xyz"
        out = json.loads(fmt.format(rec))
    finally:
        request_id_var.reset(rid_token)
        drone_id_var.reset(did_token)
    assert out["msg"] == "hello"
    assert out["level"] == "info"
    assert out["request_id"] == "req-7"
    assert out["drone_id"] == "scout-1"
    assert out["custom_field"] == "xyz"
    assert out["service"] == "test-svc"


def test_json_formatter_handles_unserializable_extra():
    fmt = JsonFormatter()
    rec = logging.LogRecord("t", logging.INFO, __file__, 1, "msg", None, None)
    rec.bad = {"self": None}
    rec.bad["self"] = rec.bad  # circular
    out = json.loads(fmt.format(rec))
    assert out["log_error"] == "unserializable_fields"


# ── health / readiness ─────────────────────────────────────────────────────────

def test_health_liveness_flips_on_shutdown():
    t = [1000.0]
    h = HealthState(now=lambda: t[0])
    assert h.liveness()["status"] == "ok"
    h.mark_shutting_down()
    assert h.liveness()["status"] == "shutting_down"


def test_readiness_needs_publisher_during_grace():
    t = [0.0]
    h = HealthState(grace_s=20.0, tick_stale_s=5.0, now=lambda: t[0])
    t[0] = 5.0
    assert h.readiness()["ready"] is False
    h.set_publisher_up(True)
    assert h.readiness()["ready"] is True  # empty tick tolerated during grace


def test_readiness_fails_on_stale_tick_after_grace():
    t = [0.0]
    h = HealthState(grace_s=20.0, tick_stale_s=5.0, now=lambda: t[0])
    h.set_publisher_up(True)
    h.record_tick(0.0)
    t[0] = 25.0  # past grace; last tick 25s ago > 5s stale
    assert h.readiness()["ready"] is False
    h.record_tick(24.0)
    assert h.readiness()["ready"] is True


def test_readiness_false_while_shutting_down():
    h = HealthState()
    h.set_publisher_up(True)
    h.record_tick()
    h.mark_shutting_down()
    assert h.readiness()["ready"] is False


# ── metrics ─────────────────────────────────────────────────────────────────────

def test_metrics_exposition_contains_series():
    m = Metrics()
    m.telemetry_frames_published.labels(drone_id="scout-1", type="TELEMETRY_UPDATE").inc()
    m.telemetry_publish_errors.inc()
    m.fleet_drones.set(3)
    text = m.expose().decode()
    assert "telemetry_frames_published_total" in text
    assert 'drone_id="scout-1"' in text
    assert "telemetry_publish_errors_total" in text
    assert "fleet_drones 3.0" in text


# ── resilient publisher ─────────────────────────────────────────────────────────

class _FakeSocket:
    """Async ZMQ-like socket that fails the first N send_string calls."""

    def __init__(self, fail_times=0):
        self.fail_times = fail_times
        self.sent = []

    async def send_string(self, s):
        if len(self.sent) < self.fail_times:
            self.sent.append(("FAIL", s))
            raise RuntimeError("transient zmq error")
        self.sent.append(("OK", s))

    def close(self):
        pass


def _make_publisher(**kwargs):
    """Build a publisher with its real ZMQ socket immediately neutralised, so a
    test can swap in a fake and teardown never blocks on context.term()."""
    from telemetry_pub import TelemetryPublisher
    pub = TelemetryPublisher(port=0, **kwargs)
    pub.socket.close(linger=0)  # drop the real PUB socket up front
    return pub


@pytest.mark.asyncio
async def test_send_zmq_retries_then_succeeds():
    m = Metrics()
    pub = _make_publisher(metrics=m, send_max_retries=3, send_backoff_ms=1)
    pub.socket = _FakeSocket(fail_times=2)  # fail twice, succeed on 3rd
    await pub._send_zmq({"type": "TELEMETRY_UPDATE", "drone_id": "scout-1"})
    oks = [x for x in pub.socket.sent if x[0] == "OK"]
    assert len(oks) == 1
    # 2 failures were counted
    text = m.expose().decode()
    assert "telemetry_publish_errors_total 2.0" in text


@pytest.mark.asyncio
async def test_send_zmq_gives_up_after_budget():
    m = Metrics()
    pub = _make_publisher(metrics=m, send_max_retries=1, send_backoff_ms=1)
    pub.socket = _FakeSocket(fail_times=99)  # always fails
    # Must NOT raise — it drops the frame after exhausting the budget.
    await pub._send_zmq({"type": "X"})
    assert all(x[0] == "FAIL" for x in pub.socket.sent)


@pytest.mark.asyncio
async def test_publish_loop_records_tick_and_survives_bad_source():
    import asyncio

    m = Metrics()
    h = HealthState()

    class _BadRegistry:
        # Looks like a registry (has all + fleet_summary) but .all() raises.
        def all(self):
            raise RuntimeError("registry boom")

        def fleet_summary(self):
            return {}

    pub = _make_publisher(metrics=m, health=h)
    pub.running = True
    task = asyncio.create_task(pub.publish_loop(_BadRegistry()))
    await asyncio.sleep(0.25)  # a few 10 Hz ticks
    pub.running = False
    await asyncio.sleep(0.15)
    task.cancel()
    # The loop kept running despite every tick raising → failures counted, no crash.
    text = m.expose().decode()
    assert "telemetry_tick_failures_total" in text
    assert float(_metric_value(text, "telemetry_tick_failures_total")) >= 1


def _metric_value(text: str, name: str) -> str:
    for line in text.splitlines():
        if line.startswith(name + " "):
            return line.split(" ", 1)[1]
    return "0"


# ── live endpoints (integration) ───────────────────────────────────────────────

def test_operational_endpoints_and_backward_compat():
    from fastapi.testclient import TestClient
    import main

    with TestClient(main.app) as client:
        # liveness
        r = client.get("/healthz")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"

        # readiness (publisher up after startup)
        r = client.get("/readyz")
        assert r.status_code in (200, 503)  # depends on grace/tick timing
        assert "checks" in r.json()

        # metrics in Prometheus text format
        r = client.get("/metrics")
        assert r.status_code == 200
        assert "telemetry_ticks_total" in r.text or "http_requests_total" in r.text

        # correlation id echoed back
        r = client.get("/healthz", headers={"x-request-id": "abc-123"})
        assert r.headers.get("x-request-id") == "abc-123"

        # backward compatibility: a legacy unscoped route still answers
        r = client.get("/connection/status")
        assert r.status_code == 200
        assert "connection_state" in r.json()
