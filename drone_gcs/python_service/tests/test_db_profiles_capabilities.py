"""Phase 5B — M3: connection_profiles (multi-transport, one active) and
drone_capabilities repos. File-backed SQLite seeded via the migration.
"""
import sys
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db.base import create_engine_from_settings
from db.migrate import run_migrations_sync
from db.repositories import build_hub
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


# ── connection profiles ───────────────────────────────────────────────────────

async def test_first_profile_is_auto_active_and_mirrors_drone(hub):
    p = await hub.connection_profiles.add(
        drone_id="d1", org_id="default", name="bench", kind="serial",
        connection_string="serial:/dev/ttyUSB0:57600", baudrate=57600,
    )
    assert p["is_active"] == 1
    active = await hub.connection_profiles.get_active("d1")
    assert active["name"] == "bench"
    # active profile mirrored onto drones.connection_string
    drone = await hub.drones.get("d1")
    assert drone["connection_string"] == "serial:/dev/ttyUSB0:57600"
    assert drone["baudrate"] == 57600


async def test_multiple_profiles_one_active(hub):
    await hub.connection_profiles.add(drone_id="d1", org_id="default", name="bench",
                                      kind="serial", connection_string="auto")
    lte = await hub.connection_profiles.add(
        drone_id="d1", org_id="default", name="field-lte", kind="lte",
        connection_string="udpout:10.0.0.5:14555", activate=True,
    )
    profiles = await hub.connection_profiles.list("d1")
    assert len(profiles) == 2
    actives = [p for p in profiles if p["is_active"]]
    assert len(actives) == 1 and actives[0]["id"] == lte["id"]
    drone = await hub.drones.get("d1")
    assert drone["connection_string"] == "udpout:10.0.0.5:14555"


async def test_activate_switches_and_remirrors(hub):
    bench = await hub.connection_profiles.add(drone_id="d1", org_id="default", name="bench",
                                              kind="serial", connection_string="serial:/dev/ttyUSB0:115200",
                                              baudrate=115200)
    lte = await hub.connection_profiles.add(drone_id="d1", org_id="default", name="lte",
                                            kind="lte", connection_string="udpout:10.0.0.5:14555")
    # bench active initially (first); activate lte then back to bench
    await hub.connection_profiles.activate(lte["id"])
    assert (await hub.connection_profiles.get_active("d1"))["id"] == lte["id"]
    await hub.connection_profiles.activate(bench["id"])
    active = await hub.connection_profiles.get_active("d1")
    assert active["id"] == bench["id"]
    assert (await hub.drones.get("d1"))["connection_string"] == "serial:/dev/ttyUSB0:115200"


async def test_delete_profile(hub):
    p = await hub.connection_profiles.add(drone_id="d1", org_id="default", name="tmp",
                                          kind="udp", connection_string="udp:127.0.0.1:14550")
    assert await hub.connection_profiles.delete(p["id"]) is True
    assert await hub.connection_profiles.delete(p["id"]) is False


# ── capabilities ──────────────────────────────────────────────────────────────

async def test_set_list_and_filter_capabilities(hub):
    await hub.drones.upsert(drone_id="d2", name="Bravo", connection_string="auto")
    await hub.capabilities.set(drone_id="d1", capability="thermal_camera",
                               spec={"model": "FLIR", "resolution": "640x512"})
    await hub.capabilities.set(drone_id="d1", capability="rtk")
    await hub.capabilities.set(drone_id="d2", capability="rgb_camera")

    caps = {c["capability"] for c in await hub.capabilities.list("d1")}
    assert caps == {"thermal_camera", "rtk"}

    thermal = await hub.capabilities.drones_with("thermal_camera")
    assert thermal == ["d1"]


async def test_set_capability_is_upsert(hub):
    await hub.capabilities.set(drone_id="d1", capability="payload", present=True)
    await hub.capabilities.set(drone_id="d1", capability="payload", present=False,
                               spec={"reason": "removed"})
    caps = await hub.capabilities.list("d1")
    payload = [c for c in caps if c["capability"] == "payload"]
    assert len(payload) == 1
    assert payload[0]["present"] == 0
    assert payload[0]["spec"] == {"reason": "removed"}


async def test_remove_capability(hub):
    await hub.capabilities.set(drone_id="d1", capability="spotlight")
    assert await hub.capabilities.remove(drone_id="d1", capability="spotlight") is True
    assert await hub.capabilities.remove(drone_id="d1", capability="spotlight") is False
