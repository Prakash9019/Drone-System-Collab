"""Phase 5B — M6: command audit hook. The wrapper audits every return path;
the sink persists a commands_audit row with drone + result + flight_id.
"""
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import command_manager as cm
from command_manager import CommandManager, set_audit_sink
from db.base import create_engine_from_settings
from db.migrate import run_migrations_sync
from db.repositories import build_hub
from db.services.command_audit import build_command_audit_sink
from db.settings import load_db_settings


@pytest.fixture(autouse=True)
def _clear_sink():
    set_audit_sink(None)
    yield
    set_audit_sink(None)


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


async def test_wrapper_audits_no_connection_path():
    """No live link → NO_CONNECTION, but the audit hook still fires."""
    seen = []
    set_audit_sink(lambda rec: _collect(seen, rec))
    mgr = CommandManager(SimpleNamespace(conn=None))
    mgr.drone_id = "d1"
    out = await mgr.execute_command(1, 1, 400, source_route="command")
    assert out["reason"] == "no_connection"
    assert len(seen) == 1
    rec = seen[0]
    assert rec["drone_id"] == "d1"
    assert rec["command"] == 400
    assert rec["source_route"] == "command"
    assert rec["params"]["p1"] == 0


async def _collect(bucket, rec):
    bucket.append(rec)


async def test_audit_failure_never_breaks_command():
    async def boom(_rec):
        raise RuntimeError("db down")
    set_audit_sink(boom)
    mgr = CommandManager(SimpleNamespace(conn=None))
    mgr.drone_id = "d1"
    out = await mgr.execute_command(1, 1, 400)     # must still return normally
    assert out["mav_result_text"] == "NO_CONNECTION"


async def test_sink_persists_audit_row(hub):
    # open a real flight so the row's flight_id satisfies the FK
    flight = await hub.flights.open_flight(drone_id="d1", org_id="default", armed_at=1.0)
    tracker = SimpleNamespace(active_flight_id=lambda did: flight["id"])
    sink = build_command_audit_sink(hub.commands, org_id="default", flight_tracker=tracker)
    set_audit_sink(sink)

    mgr = CommandManager(SimpleNamespace(conn=None))
    mgr.drone_id = "d1"
    await mgr.execute_command(3, 1, 22, p7=5.0, source_route="command")   # MAV_CMD_NAV_TAKEOFF

    rows = await hub.commands.list_for_drone("d1")
    assert len(rows) == 1
    row = rows[0]
    assert row["command"] == 22
    assert row["sysid"] == 3
    assert row["reason"] == "no_connection"
    assert row["flight_id"] == flight["id"]
    assert row["operator_id"] is None            # pre-5C
    assert row["params"]["p7"] == 5.0


async def test_sink_skips_when_no_drone_identity(hub):
    sink = build_command_audit_sink(hub.commands, org_id="default")
    set_audit_sink(sink)
    mgr = CommandManager(SimpleNamespace(conn=None))
    mgr.drone_id = None                            # legacy single-drone with no identity
    await mgr.execute_command(1, 1, 400)
    assert await hub.commands.list_for_drone("d1") == []
