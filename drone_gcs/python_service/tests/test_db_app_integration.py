"""Phase 5B — M2 headline: the F1 exit criterion through the real app.

Register a drone over HTTP with persistence enabled, simulate a process restart
(a second lifespan cycle against the same DB file), and assert the drone
survives. Needs a free ZMQ port (run the suite with ZMQ_PUB_PORT set, like the
other app-boot tests).
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture
def persistent_env(tmp_path, monkeypatch):
    db = tmp_path / "fleet.db"
    monkeypatch.setenv("FLEET_PERSISTENCE_ENABLED", "true")
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{db}")
    monkeypatch.setenv("DB_AUTO_MIGRATE", "true")
    yield


def _boot():
    from fastapi.testclient import TestClient
    import main
    return TestClient(main.app)


def test_registered_drone_survives_restart(persistent_env):
    # ── boot #1: register a drone, confirm it persisted ──────────────────────
    with _boot() as c:
        r = c.post("/fleet/drones", json={
            "drone_id": "survivor",
            "name": "Survivor",
            "connection_string": "udp:127.0.0.1:14599",
            "baudrate": 57600,
        })
        assert r.status_code == 201, r.text
        ids = {d["drone_id"] for d in c.get("/fleet").json()["drones"]}
        assert {"default", "survivor"}.issubset(ids)

    # ── boot #2 (restart): the RAM registry starts empty, must rehydrate ─────
    with _boot() as c:
        body = c.get("/fleet").json()
        ids = {d["drone_id"] for d in body["drones"]}
        assert "survivor" in ids, "F1: registered drone lost across restart"
        survivor = next(d for d in body["drones"] if d["drone_id"] == "survivor")
        assert survivor["name"] == "Survivor"
        assert survivor["connection_string"] == "udp:127.0.0.1:14599"


def test_allowlist_blocks_disallowed_registration(persistent_env):
    with _boot() as c:
        r = c.post("/fleet/drones", json={
            "drone_id": "ssrf",
            "connection_string": "tcp:169.254.169.254:80",
        })
        assert r.status_code == 422, r.text
        # and it must not have been registered
        ids = {d["drone_id"] for d in c.get("/fleet").json()["drones"]}
        assert "ssrf" not in ids


def test_registration_backfills_default_profile(persistent_env):
    with _boot() as c:
        c.post("/fleet/drones", json={
            "drone_id": "d1", "connection_string": "udp:127.0.0.1:14601",
        })
        profiles = c.get("/fleet/drones/d1/connection-profiles").json()["profiles"]
        assert len(profiles) == 1
        assert profiles[0]["is_active"] == 1
        assert profiles[0]["kind"] == "udp"


def test_add_second_profile_and_activate(persistent_env):
    with _boot() as c:
        c.post("/fleet/drones", json={"drone_id": "d1", "connection_string": "auto"})
        r = c.post("/fleet/drones/d1/connection-profiles", json={
            "name": "field-lte", "kind": "lte",
            "connection_string": "udpout:127.0.0.1:14602", "activate": True,
        })
        assert r.status_code == 201, r.text
        pid = r.json()["id"]
        actives = [p for p in c.get("/fleet/drones/d1/connection-profiles").json()["profiles"]
                   if p["is_active"]]
        assert len(actives) == 1 and actives[0]["id"] == pid

        # disallowed profile is rejected
        r = c.post("/fleet/drones/d1/connection-profiles", json={
            "name": "bad", "kind": "tcp", "connection_string": "tcp:169.254.169.254:80",
        })
        assert r.status_code == 422


def test_set_and_filter_capabilities(persistent_env):
    with _boot() as c:
        c.post("/fleet/drones", json={"drone_id": "d1", "connection_string": "auto"})
        r = c.put("/fleet/drones/d1/capabilities", json={
            "capability": "thermal_camera", "spec": {"model": "FLIR"},
        })
        assert r.status_code == 200, r.text
        caps = c.get("/fleet/drones/d1/capabilities").json()["capabilities"]
        assert {x["capability"] for x in caps} == {"thermal_camera"}
        assert c.delete("/fleet/drones/d1/capabilities/thermal_camera").status_code == 200


def test_org_settings_and_feature_flags(persistent_env):
    with _boot() as c:
        # per-org telemetry rate + retention (improvements 4 & 5)
        r = c.put("/fleet/org/settings", json={
            "telemetry_persist_hz": 2.0, "retention_telemetry_days": 30,
        })
        assert r.status_code == 200, r.text
        s = c.get("/fleet/org/settings").json()["settings"]
        assert s["telemetry_persist_hz"] == 2.0
        assert s["retention_telemetry_days"] == 30

        # feature flags (improvement 6)
        c.put("/fleet/org/feature-flags", json={"flag": "video_wall", "enabled": True,
                                                "value": {"max_tiles": 20}})
        flags = c.get("/fleet/org/feature-flags").json()["flags"]
        assert any(f["flag"] == "video_wall" and f["enabled"] == 1 for f in flags)


def test_mission_templates_and_alert_rules(persistent_env):
    with _boot() as c:
        # mission templates (improvement 3)
        r = c.post("/fleet/missions/templates", json={
            "name": "survey-grid", "definition": {"waypoints": [1, 2, 3]},
        })
        assert r.status_code == 201, r.text
        tid = r.json()["id"]
        assert any(t["id"] == tid for t in c.get("/fleet/missions/templates").json()["templates"])

        r = c.post("/fleet/missions/instances", json={
            "name": "field-A", "template_id": tid,
        })
        assert r.status_code == 201, r.text

        # alert rule config
        r = c.post("/fleet/alert-rules", json={
            "name": "low-batt", "metric": "batt_remaining", "operator": "<", "threshold": 20,
        })
        assert r.status_code == 201, r.text
        assert len(c.get("/fleet/alert-rules").json()["rules"]) == 1
