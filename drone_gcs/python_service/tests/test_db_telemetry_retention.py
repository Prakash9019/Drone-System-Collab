"""Phase 5B — M5: telemetry persistence (bounded writer, per-org rate) and
retention (per-org windows, retention_hold exemption).
"""
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db.base import create_engine_from_settings
from db.migrate import run_migrations_sync
from db.repositories import build_hub
from db.services.org_settings_resolver import OrgSettingsResolver
from db.services.persistence_sampler import PersistenceSampler
from db.services.retention_manager import RetentionManager
from db.services.flight_tracker import FlightTracker
from db.services.telemetry_writer import TelemetryWriter
from db.settings import load_db_settings


@pytest.fixture
async def ctx(tmp_path):
    url = f"sqlite+aiosqlite:///{tmp_path / 'fleet.db'}"
    settings = load_db_settings({"DATABASE_URL": url})
    run_migrations_sync(settings)
    engine = create_engine_from_settings(settings)
    hub = build_hub(async_sessionmaker(engine, expire_on_commit=False))
    await hub.drones.upsert(drone_id="d1", name="Alpha", connection_string="auto")
    yield SimpleNamespace(hub=hub, settings=settings)
    await engine.dispose()


# ── telemetry repo ────────────────────────────────────────────────────────────

async def test_write_batch_and_query_track(ctx):
    rows = [
        {"drone_id": "d1", "sysid": 1, "recorded_at": float(t), "lat": 47.0 + t * 1e-4,
         "lon": 8.0, "alt_rel": t, "mode": "AUTO", "armed": 1}
        for t in range(5)
    ]
    n = await ctx.hub.telemetry.write_batch(rows)
    assert n == 5
    track = await ctx.hub.telemetry.query_track("d1", t0=1.0, t1=3.0)
    assert [r["recorded_at"] for r in track] == [1.0, 2.0, 3.0]
    assert await ctx.hub.telemetry.count_for_drone("d1") == 5


async def test_prune_respects_retention_hold(ctx):
    f = await ctx.hub.flights.open_flight(drone_id="d1", org_id="default", armed_at=0.0)
    # mark that flight held
    from sqlalchemy import update
    from db.schema import flights
    async with ctx.hub._sm() as s:
        async with s.begin():
            await s.execute(update(flights).where(flights.c.id == f["id"]).values(retention_hold=1))

    await ctx.hub.telemetry.write_batch([
        {"drone_id": "d1", "sysid": 1, "recorded_at": 10.0, "flight_id": None},       # prunable
        {"drone_id": "d1", "sysid": 1, "recorded_at": 11.0, "flight_id": f["id"]},    # held → exempt
    ])
    pruned = await ctx.hub.telemetry.prune(cutoff=100.0, org_id="default")
    assert pruned == 1
    remaining = await ctx.hub.telemetry.query_track("d1")
    assert len(remaining) == 1 and remaining[0]["flight_id"] == f["id"]


# ── bounded writer (drop-oldest) ──────────────────────────────────────────────

class _FakeMetrics:
    class _C:
        def __init__(self): self.n = 0
        def inc(self, v=1): self.n += v
        def set(self, v): self.n = v
    def __init__(self):
        self.telemetry_persist_written = self._C()
        self.telemetry_persist_dropped = self._C()
        self.telemetry_persist_queue_depth = self._C()


async def test_writer_drops_oldest_when_full(ctx):
    m = _FakeMetrics()
    w = TelemetryWriter(ctx.hub.telemetry, queue_max=3, batch_size=100, metrics=m)
    for t in range(5):                                  # 5 into a depth-3 queue
        w.enqueue("d1", None, {"sysid": 1}, float(t))
    assert m.telemetry_persist_dropped.n == 2           # 2 oldest dropped
    await w._flush()
    assert await ctx.hub.telemetry.count_for_drone("d1") == 3
    assert m.telemetry_persist_written.n == 3


# ── per-org resolver + rate gate ──────────────────────────────────────────────

async def test_resolver_falls_back_then_honours_override(ctx):
    r = OrgSettingsResolver(ctx.hub.org, ctx.settings, ttl_s=0.0)
    assert await r.persist_hz("default") == 1.0                 # env default
    assert await r.retention_days("default", "retention_telemetry_days") == 90
    await ctx.hub.org.upsert_settings("default", telemetry_persist_hz=5.0,
                                      retention_telemetry_days=7)
    assert await r.persist_hz("default") == 5.0                 # override wins
    assert await r.retention_days("default", "retention_telemetry_days") == 7


async def test_sampler_rate_gate_downsamples(ctx):
    # org persists at 1 Hz; sampler polls at 10 Hz → ~1 row/sec, not 10.
    await ctx.hub.org.upsert_settings("default", telemetry_persist_hz=1.0)
    r = OrgSettingsResolver(ctx.hub.org, ctx.settings, ttl_s=0.0)
    tracker = FlightTracker(ctx.hub.flights, org_id="default")
    writer = TelemetryWriter(ctx.hub.telemetry, queue_max=1000, batch_size=1000)
    vehicle = SimpleNamespace(sysid=1,
                              status=SimpleNamespace(armed=True, mode="AUTO", gps_fix=3, satellites=10),
                              position=SimpleNamespace(lat=47.0, lng=8.0, alt_rel=5, alt_amsl=405),
                              velocity=SimpleNamespace(heading=0, groundspeed=1),
                              battery=SimpleNamespace(voltage=12, remaining=90))
    session = SimpleNamespace(drone_id="d1", online=True,
                              link_manager=SimpleNamespace(vehicles={1: vehicle}))
    reg = SimpleNamespace(all=lambda: [session])
    sampler = PersistenceSampler(reg, ctx.hub, tracker, org_id="default",
                                 sample_hz=10.0, telemetry_writer=writer, resolver=r)
    # simulate 2 seconds of 10 Hz polling
    for i in range(21):
        await sampler._sample_once(i * 0.1)
    await writer._flush()
    count = await ctx.hub.telemetry.count_for_drone("d1")
    assert 2 <= count <= 3, f"expected ~1 Hz downsample, got {count}"


# ── retention manager ─────────────────────────────────────────────────────────

async def test_retention_manager_prunes_per_org_window(ctx):
    now = 1_000_000.0
    await ctx.hub.org.upsert_settings("default", retention_telemetry_days=1)  # 1-day window
    # one old row (2 days), one fresh (now)
    await ctx.hub.telemetry.write_batch([
        {"drone_id": "d1", "sysid": 1, "recorded_at": now - 2 * 86400},
        {"drone_id": "d1", "sysid": 1, "recorded_at": now - 60},
    ])
    r = OrgSettingsResolver(ctx.hub.org, ctx.settings, ttl_s=0.0)
    mgr = RetentionManager(ctx.hub, r)
    pruned = await mgr.run_once(now=now)
    assert pruned["telemetry_history"] == 1
    assert await ctx.hub.telemetry.count_for_drone("d1") == 1
