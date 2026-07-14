"""Phase 5B — M2/M3: drones repo, registry rehydration (F1), connection
allow-list (F2). File-backed SQLite (not :memory:, which is per-connection) so
multi-statement flows share one database.
"""
import sys
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db.base import create_engine_from_settings
from db.migrate import run_migrations_sync
from db.repositories import build_hub
from db.repositories.allowlist_repo import parse_connection_string
from db.settings import load_db_settings
from fleet import SessionRegistry


@pytest.fixture
async def hub(tmp_path):
    url = f"sqlite+aiosqlite:///{tmp_path / 'fleet.db'}"
    settings = load_db_settings({"DATABASE_URL": url})
    run_migrations_sync(settings)                 # seeds default org/drone/allowlist
    engine = create_engine_from_settings(settings)
    sm = async_sessionmaker(engine, expire_on_commit=False)
    h = build_hub(sm)
    yield h
    await engine.dispose()


# ── drones repo ───────────────────────────────────────────────────────────────

async def test_upsert_get_and_list(hub):
    await hub.drones.upsert(drone_id="d1", name="Alpha", connection_string="tcp:127.0.0.1:5762")
    got = await hub.drones.get("d1")
    assert got["name"] == "Alpha"
    assert got["connection_string"] == "tcp:127.0.0.1:5762"

    ids = {r["id"] for r in await hub.drones.list_for_rehydrate()}
    assert {"default", "d1"}.issubset(ids)


async def test_upsert_is_update_on_conflict(hub):
    await hub.drones.upsert(drone_id="d1", name="Alpha", connection_string="auto")
    await hub.drones.upsert(drone_id="d1", name="Alpha-renamed", connection_string="udp:127.0.0.1:14551")
    got = await hub.drones.get("d1")
    assert got["name"] == "Alpha-renamed"
    assert got["connection_string"] == "udp:127.0.0.1:14551"


async def test_archive_excludes_from_rehydrate(hub):
    await hub.drones.upsert(drone_id="d1", name="Alpha")
    assert await hub.drones.archive("d1") is True
    ids = {r["id"] for r in await hub.drones.list_for_rehydrate()}
    assert "d1" not in ids


# ── registry rehydration (F1 exit criterion) ─────────────────────────────────

async def test_rehydration_restores_registered_drones(hub):
    # Simulate: three drones registered, then a process restart (fresh registry).
    await hub.drones.upsert(drone_id="d1", name="Alpha", connection_string="tcp:127.0.0.1:5762")
    await hub.drones.upsert(drone_id="d2", name="Bravo", connection_string="tcp:127.0.0.1:5772")
    await hub.drones.upsert(drone_id="d3", name="Charlie", connection_string="udp:127.0.0.1:14561")

    fresh = SessionRegistry()
    n = await fresh.load_from_db(hub.drones)

    assert n == 4                                  # d1,d2,d3 + seeded 'default'
    assert set(fresh.ids()) == {"default", "d1", "d2", "d3"}
    assert fresh.get("d2").name == "Bravo"
    assert fresh.get("d2").link_manager.connection_string == "tcp:127.0.0.1:5772"


async def test_rehydration_skips_archived(hub):
    await hub.drones.upsert(drone_id="d1", name="Alpha")
    await hub.drones.archive("d1")
    fresh = SessionRegistry()
    await fresh.load_from_db(hub.drones)
    assert "d1" not in fresh.ids()


# ── connection allow-list (F2) ───────────────────────────────────────────────

async def test_allowlist_permits_seeded_ranges(hub):
    assert await hub.allowlist.is_allowed("tcp:127.0.0.1:5760") is True
    assert await hub.allowlist.is_allowed("tcp:127.0.0.1:5763") is True
    assert await hub.allowlist.is_allowed("udp:127.0.0.1:14550") is True
    assert await hub.allowlist.is_allowed("udpout:127.0.0.1:14600") is True
    assert await hub.allowlist.is_allowed("auto") is True
    assert await hub.allowlist.is_allowed("serial:/dev/ttyUSB0:57600") is True


async def test_allowlist_rejects_ssrf_and_out_of_range(hub):
    # cloud metadata endpoint — the classic SSRF target
    assert await hub.allowlist.is_allowed("tcp:169.254.169.254:80") is False
    # right host, wrong port
    assert await hub.allowlist.is_allowed("tcp:127.0.0.1:9999") is False
    # arbitrary external host
    assert await hub.allowlist.is_allowed("tcp:evil.example.com:5760") is False
    # unknown scheme
    assert await hub.allowlist.is_allowed("ftp:127.0.0.1:21") is False
    # serial device outside glob
    assert await hub.allowlist.is_allowed("serial:/root/secret:57600") is False


@pytest.mark.parametrize("cs,expected", [
    ("auto", ("serial", None, None, None)),
    ("tcp:127.0.0.1:5760", ("tcp", "127.0.0.1", 5760, None)),
    ("udpin:0.0.0.0:14550", ("udp", "0.0.0.0", 14550, None)),
    ("udpout:10.0.0.5:14555", ("udp", "10.0.0.5", 14555, None)),
    ("serial:/dev/ttyACM0:115200", ("serial", None, None, "/dev/ttyACM0")),
    ("/dev/ttyUSB0", ("serial", None, None, "/dev/ttyUSB0")),
])
def test_parse_connection_string(cs, expected):
    assert parse_connection_string(cs) == expected
