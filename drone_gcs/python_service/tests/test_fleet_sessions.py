"""Phase 3 tests — DroneSession / SessionRegistry / fleet routes / legacy back-compat.

No real MAVLink transport is opened anywhere in these tests: sessions are
created but never connect()ed, which exercises registration, isolation,
summaries, and the API surface.
"""
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fleet import SessionRegistry, DEFAULT_DRONE_ID
from fleet.drone_session import DroneSession


# ── DroneSession ──────────────────────────────────────────────────────────────

def test_session_bundles_isolated_managers():
    a = DroneSession(drone_id="a", connection_string="udp:127.0.0.1:14551")
    b = DroneSession(drone_id="b", connection_string="udp:127.0.0.1:14552")
    assert a.link_manager is not b.link_manager
    assert a.mission_manager.lm is a.link_manager
    assert b.mission_manager.lm is b.link_manager
    assert a.parameter_manager is not b.parameter_manager
    assert a.link_manager.mission_manager is a.mission_manager
    assert a.link_manager.parameter_manager is a.parameter_manager


def test_session_calibration_state_is_per_drone():
    a = DroneSession(drone_id="a")
    b = DroneSession(drone_id="b")

    class FakeMsg:
        compass_id = 0
        completion_pct = 50.0
        cal_status = 1

    a._on_mag_cal("MAG_CAL_PROGRESS", FakeMsg())
    a._on_accel_cal_pos(3)
    assert a.mag_cal_data[0]["pct"] == 50.0
    assert a.accel_cal_pos == 3
    assert b.mag_cal_data == {}
    assert b.accel_cal_pos == 0
    # callbacks are wired into the session's own link manager
    assert a.link_manager._mag_cal_cb == a._on_mag_cal


def test_session_summary_shape():
    s = DroneSession(drone_id="x", name="Falcon", connection_string="udp:127.0.0.1:14553")
    summary = s.to_summary()
    for key in ("drone_id", "name", "connection_state", "online", "last_seen",
                "primary_sysid", "vehicles", "mission_transfer", "param_sync"):
        assert key in summary, f"missing {key}"
    assert summary["drone_id"] == "x"
    assert summary["name"] == "Falcon"
    assert summary["online"] is False


def test_session_generates_drone_id_when_absent():
    s = DroneSession()
    assert s.drone_id and len(s.drone_id) >= 8


# ── SessionRegistry ───────────────────────────────────────────────────────────

def test_registry_create_get_and_duplicate_rejection():
    reg = SessionRegistry()
    s = reg.create(drone_id="d1", connection_string="udp:127.0.0.1:14561")
    assert reg.get("d1") is s
    assert reg.require("d1") is s
    with pytest.raises(ValueError):
        reg.create(drone_id="d1")
    with pytest.raises(KeyError):
        reg.require("nope")


def test_registry_remove_and_default_protection():
    reg = SessionRegistry()
    reg.create(drone_id=DEFAULT_DRONE_ID)
    reg.create(drone_id="d2")

    async def run():
        assert await reg.remove("d2") is True
        assert reg.get("d2") is None
        assert await reg.remove("d2") is False  # already gone
        with pytest.raises(ValueError):
            await reg.remove(DEFAULT_DRONE_ID)

    asyncio.run(run())
    assert reg.default is not None


def test_registry_fleet_summary():
    reg = SessionRegistry()
    reg.create(drone_id=DEFAULT_DRONE_ID)
    reg.create(drone_id="d2", name="Scout")
    summary = reg.fleet_summary()
    assert summary["count"] == 2
    assert summary["online"] == 0
    ids = {d["drone_id"] for d in summary["drones"]}
    assert ids == {DEFAULT_DRONE_ID, "d2"}


# ── Fleet API + legacy back-compat (full app via TestClient) ─────────────────

@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    import main
    with TestClient(main.app) as c:
        yield c


def test_app_boots_with_default_session(client):
    r = client.get("/fleet")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] >= 1
    assert any(d["drone_id"] == DEFAULT_DRONE_ID for d in body["drones"])


def test_register_list_and_deregister_drone(client):
    r = client.post("/fleet/drones", json={
        "drone_id": "test-drone",
        "name": "Test Drone",
        "connection_string": "udp:127.0.0.1:14599",
        "baudrate": 57600,
    })
    assert r.status_code == 201, r.text
    assert r.json()["drone_id"] == "test-drone"

    # duplicate registration → 409
    r = client.post("/fleet/drones", json={"drone_id": "test-drone"})
    assert r.status_code == 409

    r = client.get("/fleet/drones/test-drone")
    assert r.status_code == 200
    assert r.json()["connection_string"] == "udp:127.0.0.1:14599"

    # state with no vehicle connected mirrors legacy behavior
    r = client.get("/fleet/drones/test-drone/state")
    assert r.status_code == 200
    assert r.json().get("error") == "No vehicle connected"

    r = client.delete("/fleet/drones/test-drone")
    assert r.status_code == 200
    r = client.get("/fleet/drones/test-drone")
    assert r.status_code == 404


def test_unknown_drone_is_404(client):
    assert client.get("/fleet/drones/ghost").status_code == 404
    assert client.post("/fleet/drones/ghost/command", json={"command": 400}).status_code == 404


def test_default_session_cannot_be_deregistered(client):
    r = client.delete(f"/fleet/drones/{DEFAULT_DRONE_ID}")
    assert r.status_code == 400


def test_legacy_routes_still_work(client):
    # The pre-fleet API surface must behave exactly as before (no vehicle connected)
    r = client.get("/state")
    assert r.status_code == 200
    assert "connection_state" in r.json()

    r = client.get("/connection/status")
    assert r.status_code == 200
    assert r.json()["connection_state"] == "DISCONNECTED"

    r = client.get("/vehicles")
    assert r.status_code == 200
    assert r.json()["vehicles"] == []

    r = client.get("/calibration/status")
    assert r.status_code == 200
    assert r.json()["accel_requested_pos"] == 0


def test_command_without_vehicle_fails_cleanly(client):
    r = client.post("/fleet/drones/default/command", json={"command": 400})
    assert r.status_code == 500  # No vehicle connected — same as legacy /command
