"""Phase 5B — M7: object store (fs), recordings metadata, and the config-only
repos (missions, alerts, provisioning tokens).
"""
import sys
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db.base import create_engine_from_settings
from db.migrate import run_migrations_sync
from db.repositories import build_hub
from db.repositories.objectstore import FsObjectStore, build_object_store
from db.settings import load_db_settings


@pytest.fixture
async def hub(tmp_path):
    url = f"sqlite+aiosqlite:///{tmp_path / 'fleet.db'}"
    settings = load_db_settings({"DATABASE_URL": url})
    run_migrations_sync(settings)
    engine = create_engine_from_settings(settings)
    store = FsObjectStore(str(tmp_path / "blobs"))
    h = build_hub(async_sessionmaker(engine, expire_on_commit=False), object_store=store)
    await h.drones.upsert(drone_id="d1", name="Alpha", connection_string="auto")
    yield h
    await engine.dispose()


# ── object store ──────────────────────────────────────────────────────────────

def test_fs_store_roundtrip(tmp_path):
    store = FsObjectStore(str(tmp_path / "blobs"))
    uri = store.put_bytes("recordings/x.jsonl", b"hello")
    assert uri == "fs://recordings/x.jsonl"
    assert store.exists(uri)
    with store.open(uri) as f:
        assert f.read() == b"hello"
    stat = store.stat(uri)
    assert stat.size_bytes == 5 and stat.checksum
    assert store.delete(uri) is True
    assert not store.exists(uri)


def test_fs_store_rejects_path_escape(tmp_path):
    store = FsObjectStore(str(tmp_path / "blobs"))
    with pytest.raises(ValueError):
        store.put_bytes("../../etc/passwd", b"x")


def test_build_object_store_defaults_to_fs(tmp_path):
    assert build_object_store(None, default_root=str(tmp_path)).scheme == "fs"
    with pytest.raises(NotImplementedError):
        build_object_store("s3://bucket/key", default_root=str(tmp_path))


# ── recordings ────────────────────────────────────────────────────────────────

async def test_recordings_register_list_and_delete_blob(hub, tmp_path):
    uri = hub.object_store.put_bytes("recordings/r1.jsonl", b"telemetry")
    rec = await hub.recordings.register(
        org_id="default", drone_id="d1", backend="fs", uri=uri, size_bytes=9)
    assert rec["uri"] == uri
    listed = await hub.recordings.list(org_id="default")
    assert len(listed) == 1
    # deleting the row also deletes the blob
    assert await hub.recordings.delete(rec["id"]) is True
    assert not hub.object_store.exists(uri)
    assert await hub.recordings.list(org_id="default") == []


# ── missions (improvement 3) ──────────────────────────────────────────────────

async def test_mission_template_instance_run_lifecycle(hub):
    tmpl = await hub.missions.create_template(
        org_id="default", name="survey-grid", definition={"waypoints": [1, 2, 3]})
    assert tmpl["version"] == 1
    templates = await hub.missions.list_templates("default")
    assert len(templates) == 1

    inst = await hub.missions.create_instance(
        org_id="default", name="field-A survey", template_id=tmpl["id"], drone_id="d1")
    assert inst["status"] == "draft"
    await hub.missions.set_instance_status(inst["id"], "ready")
    assert (await hub.missions.get_instance(inst["id"]))["status"] == "ready"

    run = await hub.missions.start_run(
        org_id="default", drone_id="d1", instance_id=inst["id"], template_id=tmpl["id"])
    assert run["outcome"] is None
    done = await hub.missions.finish_run(run["id"], outcome="completed",
                                         progress={"reached_seq": 3, "total": 3})
    assert done["outcome"] == "completed"
    assert len(await hub.missions.list_runs(drone_id="d1")) == 1


async def test_archived_template_excluded_by_default(hub):
    tmpl = await hub.missions.create_template(org_id="default", name="t", definition={})
    await hub.missions.archive_template(tmpl["id"])
    assert await hub.missions.list_templates("default") == []
    assert len(await hub.missions.list_templates("default", include_archived=True)) == 1


# ── alerts (config-only) ──────────────────────────────────────────────────────

async def test_alert_rule_crud_and_fire_clear(hub):
    rule = await hub.alerts.create_rule(
        org_id="default", name="low-batt", metric="batt_remaining", operator="<", threshold=20)
    assert rule["enabled"] == 1
    assert len(await hub.alerts.list_rules("default")) == 1

    alert = await hub.alerts.fire(org_id="default", severity="critical", message="battery low",
                                  alert_rule_id=rule["id"], drone_id="d1")
    active = await hub.alerts.list_active("default")
    assert len(active) == 1
    await hub.alerts.clear(alert["id"])
    assert await hub.alerts.list_active("default") == []

    assert await hub.alerts.delete_rule(rule["id"]) is True


# ── provisioning tokens ───────────────────────────────────────────────────────

async def test_provisioning_mint_and_redeem_single_use(hub):
    clear, row = await hub.provisioning.mint(org_id="default", ttl_s=3600)
    assert row["used_at"] is None
    redeemed = await hub.provisioning.redeem(clear, created_drone_id="d1")
    assert redeemed is not None and redeemed["created_drone_id"] == "d1"
    # single-use: second redeem fails
    assert await hub.provisioning.redeem(clear, created_drone_id="d1") is None


async def test_provisioning_rejects_expired_and_unknown(hub):
    clear, _ = await hub.provisioning.mint(org_id="default", ttl_s=10)
    assert await hub.provisioning.redeem(clear, created_drone_id="d1", now=1e12) is None  # expired
    assert await hub.provisioning.redeem("bogus", created_drone_id="d1") is None          # unknown
