"""Phase 5B — M4: flights repo, FlightTracker (arm→disarm detection, rollup,
link-loss / stale closure), and the PersistenceSampler driving the tracker.
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
from db.services.flight_tracker import FlightTracker
from db.services.persistence_sampler import PersistenceSampler
from db.settings import load_db_settings


@pytest.fixture
async def hub(tmp_path):
    url = f"sqlite+aiosqlite:///{tmp_path / 'fleet.db'}"
    settings = load_db_settings({"DATABASE_URL": url})
    run_migrations_sync(settings)
    engine = create_engine_from_settings(settings)
    h = build_hub(async_sessionmaker(engine, expire_on_commit=False))
    await h.drones.upsert(drone_id="d1", name="Alpha", connection_string="auto")
    yield h
    await engine.dispose()


# ── flights repo ──────────────────────────────────────────────────────────────

async def test_open_close_and_rollup(hub):
    f = await hub.flights.open_flight(drone_id="d1", org_id="default", sysid=1,
                                      armed_at=100.0, start_mode="GUIDED")
    assert f["disarmed_at"] is None
    assert (await hub.flights.get_open("d1"))["id"] == f["id"]

    closed = await hub.flights.close_flight(f["id"], disarmed_at=250.0, end_reason="disarm",
                                            max_alt_rel=42.0, distance_m=1234.5)
    assert closed["disarmed_at"] == 250.0
    assert closed["duration_s"] == 150.0
    assert closed["max_alt_rel"] == 42.0
    assert closed["end_reason"] == "disarm"
    assert await hub.flights.get_open("d1") is None


async def test_close_is_idempotent(hub):
    f = await hub.flights.open_flight(drone_id="d1", org_id="default", armed_at=1.0)
    await hub.flights.close_flight(f["id"], disarmed_at=5.0)
    again = await hub.flights.close_flight(f["id"], disarmed_at=99.0)
    assert again["disarmed_at"] == 5.0                # not overwritten


async def test_close_stale_inflight(hub):
    await hub.flights.open_flight(drone_id="d1", org_id="default", armed_at=1.0)
    await hub.flights.open_flight(drone_id="d1", org_id="default", armed_at=2.0)
    n = await hub.flights.close_stale_inflight(end_reason="timeout")
    assert n == 2
    assert await hub.flights.get_open("d1") is None


# ── FlightTracker ─────────────────────────────────────────────────────────────

async def test_tracker_arm_disarm_cycle(hub):
    t = FlightTracker(hub.flights, org_id="default")
    await t.observe(drone_id="d1", sysid=1, armed=False, now=10.0)   # no flight yet
    assert t.active_flight_id("d1") is None

    await t.observe(drone_id="d1", sysid=1, armed=True, mode="AUTO",
                    lat=47.0, lon=8.0, alt_rel=0.0, now=11.0)
    fid = t.active_flight_id("d1")
    assert fid is not None

    # climb + move
    await t.observe(drone_id="d1", sysid=1, armed=True, lat=47.001, lon=8.0, alt_rel=30.0, now=12.0)
    await t.observe(drone_id="d1", sysid=1, armed=True, lat=47.001, lon=8.0, alt_rel=25.0, now=13.0)

    await t.observe(drone_id="d1", sysid=1, armed=False, now=20.0)
    assert t.active_flight_id("d1") is None

    flight = await hub.flights.get(fid)
    assert flight["end_reason"] == "disarm"
    assert flight["start_mode"] == "AUTO"
    assert flight["max_alt_rel"] == 30.0
    assert flight["distance_m"] > 100.0               # ~111 m for 0.001° latitude


async def test_tracker_link_loss_closes_flight(hub):
    t = FlightTracker(hub.flights, org_id="default")
    await t.observe(drone_id="d1", sysid=1, armed=True, now=1.0)
    fid = t.active_flight_id("d1")
    await t.close_on_link_loss("d1", now=5.0)
    assert t.active_flight_id("d1") is None
    assert (await hub.flights.get(fid))["end_reason"] == "link_lost"


async def test_tracker_close_all_shutdown(hub):
    t = FlightTracker(hub.flights, org_id="default")
    await t.observe(drone_id="d1", sysid=1, armed=True, now=1.0)
    fid = t.active_flight_id("d1")
    await t.close_all(reason="shutdown")
    assert (await hub.flights.get(fid))["end_reason"] == "shutdown"


# ── PersistenceSampler (fake sessions) ────────────────────────────────────────

def _fake_session(drone_id, *, armed, online=True, lat=47.0, lon=8.0, alt_rel=10.0, sysid=1):
    vehicle = SimpleNamespace(
        sysid=sysid,
        status=SimpleNamespace(armed=armed, mode="AUTO", gps_fix=3, satellites=12),
        position=SimpleNamespace(lat=lat, lng=lon, alt_rel=alt_rel, alt_amsl=alt_rel + 400),
        velocity=SimpleNamespace(heading=90, groundspeed=5.0),
        battery=SimpleNamespace(voltage=12.4, remaining=88),
    )
    return SimpleNamespace(
        drone_id=drone_id, online=online,
        link_manager=SimpleNamespace(vehicles={sysid: vehicle}),
    )


class _FakeRegistry:
    def __init__(self, sessions):
        self._s = sessions

    def all(self):
        return list(self._s)


async def test_sampler_records_flight_from_transitions(hub):
    t = FlightTracker(hub.flights, org_id="default")
    session = _fake_session("d1", armed=False)
    reg = _FakeRegistry([session])
    sampler = PersistenceSampler(reg, hub, t, org_id="default", sample_hz=100.0, link_loss_grace_s=0.0)

    await sampler._sample_once(1.0)                    # disarmed
    assert t.active_flight_id("d1") is None
    session.link_manager.vehicles[1].status.armed = True
    await sampler._sample_once(2.0)                    # armed → flight opens
    fid = t.active_flight_id("d1")
    assert fid is not None
    session.link_manager.vehicles[1].status.armed = False
    await sampler._sample_once(3.0)                    # disarmed → flight closes
    assert (await hub.flights.get(fid))["end_reason"] == "disarm"


async def test_sampler_link_loss_closes_after_grace(hub):
    t = FlightTracker(hub.flights, org_id="default")
    session = _fake_session("d1", armed=True)
    reg = _FakeRegistry([session])
    sampler = PersistenceSampler(reg, hub, t, org_id="default", sample_hz=100.0, link_loss_grace_s=3.0)

    await sampler._sample_once(1.0)                    # armed, online → open
    fid = t.active_flight_id("d1")
    session.online = False
    await sampler._sample_once(3.0)                    # first offline tick (grace clock starts) → open
    assert t.active_flight_id("d1") == fid
    await sampler._sample_once(7.0)                    # 4s > 3s grace → link_lost close
    assert t.active_flight_id("d1") is None
    assert (await hub.flights.get(fid))["end_reason"] == "link_lost"
