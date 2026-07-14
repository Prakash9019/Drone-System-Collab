"""Fleet API routes — drone_id-scoped counterparts of the legacy single-drone routes.

Legacy unscoped routes in main.py keep working against the "default" session;
these routes address any registered session explicitly. Route logic mirrors the
legacy handlers 1:1 so behavior stays identical per drone.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from fleet.session_registry import SessionRegistry
from fleet.drone_session import DroneSession
from mission_models import MissionTransferRequest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/fleet", tags=["fleet"])

_registry: Optional[SessionRegistry] = None
_repos = None                       # RepositoryHub | None — set only when persistence is enabled
_flight_tracker = None              # FlightTracker | None
_org_resolver = None                # OrgSettingsResolver | None
_org_id: str = "default"            # pre-5C: every drone lives in the default org


def set_registry(registry: SessionRegistry) -> None:
    global _registry
    _registry = registry


def set_flight_tracker(tracker) -> None:
    global _flight_tracker
    _flight_tracker = tracker


def set_org_resolver(resolver) -> None:
    global _org_resolver
    _org_resolver = resolver


def set_repositories(repos, *, org_id: str = "default") -> None:
    """Enable DB write-through for registration/deregistration. When unset
    (persistence off), routes behave exactly as before — RAM only."""
    global _repos, _org_id
    _repos = repos
    _org_id = org_id


def _require_repos():
    if _repos is None:
        raise HTTPException(status_code=503, detail="Persistence layer is disabled (FLEET_PERSISTENCE_ENABLED)")
    return _repos


def _infer_kind(connection_string: str) -> str:
    """Map a mavutil connection string to a profile 'kind' label."""
    from db.repositories.allowlist_repo import parse_connection_string
    scheme, _host, _port, _dev = parse_connection_string(connection_string)
    return {"tcp": "tcp", "udp": "udp", "serial": "serial"}.get(scheme, "udp")


def _require_session(drone_id: str) -> DroneSession:
    if _registry is None:
        raise HTTPException(status_code=500, detail="Fleet registry not initialized")
    try:
        return _registry.require(drone_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown drone_id: {drone_id}")


# ── request models ───────────────────────────────────────────────────────────
class DroneRegistration(BaseModel):
    drone_id: str | None = None
    name: str | None = None
    connection_string: str = "auto"
    baudrate: int = 115200
    udp_forwarding_endpoints: list[str] = []
    metadata: dict = {}
    auto_connect: bool = False


class ConnectionStartRequest(BaseModel):
    connection_string: str | None = None
    baudrate: int | None = None


class CommandRequest(BaseModel):
    command: int
    p1: float = 0
    p2: float = 0
    p3: float = 0
    p4: float = 0
    p5: float = 0
    p6: float = 0
    p7: float = 0


class ModeRequest(BaseModel):
    mode: str


class VehicleSelectRequest(BaseModel):
    sysid: int


class ParameterSetRequest(BaseModel):
    param_id: str
    param_value: float


# ── fleet-level ──────────────────────────────────────────────────────────────
@router.get("")
async def fleet_summary():
    if _registry is None:
        raise HTTPException(status_code=500, detail="Fleet registry not initialized")
    return _registry.fleet_summary()


@router.get("/drones")
async def list_drones():
    if _registry is None:
        raise HTTPException(status_code=500, detail="Fleet registry not initialized")
    return {"drones": [s.to_summary() for s in _registry.all()]}


@router.post("/drones", status_code=201)
async def register_drone(req: DroneRegistration):
    if _registry is None:
        raise HTTPException(status_code=500, detail="Fleet registry not initialized")
    if _repos is not None:
        allowed = await _repos.allowlist.is_allowed(req.connection_string, org_id=_org_id,
                                                    baudrate=req.baudrate)
        if not allowed:
            raise HTTPException(
                status_code=422,
                detail=f"connection_string not permitted by allow-list: {req.connection_string!r}",
            )
    try:
        session = _registry.create(
            drone_id=req.drone_id,
            name=req.name,
            connection_string=req.connection_string,
            baudrate=req.baudrate,
            udp_forwarding_endpoints=req.udp_forwarding_endpoints,
            metadata=req.metadata,
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))

    # DB is the source of truth (ADR-001): persist, then keep RAM as the cache.
    # If persistence fails, roll back the RAM session so the two never diverge.
    if _repos is not None:
        try:
            await _repos.drones.upsert(
                drone_id=session.drone_id,
                name=session.name,
                org_id=_org_id,
                connection_string=req.connection_string,
                baudrate=req.baudrate,
                udp_forwarding=req.udp_forwarding_endpoints or None,
                auto_connect=req.auto_connect,
                metadata=req.metadata or None,
                created_at=session.created_at,
            )
            # Every drone owns at least one connection profile mirroring its
            # registration transport (improvement 1); the active one mirrors
            # back onto drones.connection_string.
            if await _repos.connection_profiles.get_active(session.drone_id) is None:
                await _repos.connection_profiles.add(
                    drone_id=session.drone_id, org_id=_org_id, name="default",
                    kind=_infer_kind(req.connection_string),
                    connection_string=req.connection_string, baudrate=req.baudrate,
                    udp_forwarding=req.udp_forwarding_endpoints or None, activate=True,
                )
        except Exception as e:  # noqa: BLE001
            await _registry.remove(session.drone_id)
            logger.exception("register_drone: DB persist failed, rolled back RAM session")
            raise HTTPException(status_code=500, detail=f"failed to persist drone: {e}")

    if req.auto_connect:
        await session.connect()
    return session.to_summary()


@router.delete("/drones/{drone_id}")
async def deregister_drone(drone_id: str):
    if _registry is None:
        raise HTTPException(status_code=500, detail="Fleet registry not initialized")
    try:
        removed = await _registry.remove(drone_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not removed:
        raise HTTPException(status_code=404, detail=f"Unknown drone_id: {drone_id}")
    # Soft-delete in the DB so the drone doesn't rehydrate on the next restart.
    if _repos is not None:
        try:
            await _repos.drones.archive(drone_id)
        except Exception:
            logger.exception("deregister_drone: DB archive failed for %s", drone_id)
    return {"status": "removed", "drone_id": drone_id}


# ── per-drone: identity / connection ─────────────────────────────────────────
@router.get("/drones/{drone_id}")
async def drone_summary(drone_id: str):
    return _require_session(drone_id).to_summary()


@router.post("/drones/{drone_id}/connection/start")
async def drone_connection_start(drone_id: str, req: ConnectionStartRequest):
    session = _require_session(drone_id)
    lm = session.link_manager
    if lm._connect_lock.locked():
        return {
            "status": "connect_in_progress",
            "connection_state": lm.connection_state.value,
            "diagnostics": lm.connection_diagnostics(),
        }
    success = await session.connect(req.connection_string, req.baudrate)
    return {
        "status": "connected" if success else "failed",
        "connection_state": lm.connection_state.value,
        "diagnostics": lm.connection_diagnostics(),
    }


@router.post("/drones/{drone_id}/connection/stop")
async def drone_connection_stop(drone_id: str):
    session = _require_session(drone_id)
    await session.disconnect()
    return {"status": "stopped"}


@router.get("/drones/{drone_id}/connection/status")
async def drone_connection_status(drone_id: str):
    lm = _require_session(drone_id).link_manager
    return {
        "connection_state": lm.connection_state.value,
        "primary_sysid": lm.primary_sysid,
        "last_heartbeat": lm.last_heartbeat_time,
        "running": lm.running,
        "vehicles": lm.list_vehicles_payload(),
        "diagnostics": lm.connection_diagnostics(),
    }


# ── per-drone: state / vehicles ──────────────────────────────────────────────
@router.get("/drones/{drone_id}/state")
async def drone_state(drone_id: str):
    lm = _require_session(drone_id).link_manager
    if not lm.primary_sysid:
        return {"error": "No vehicle connected", "connection_state": lm.connection_state.value}
    vehicle = lm.vehicles.get(lm.primary_sysid)
    if vehicle:
        return vehicle.to_dict()
    return {"error": "Vehicle state not found"}


@router.get("/drones/{drone_id}/vehicles")
async def drone_vehicles(drone_id: str):
    lm = _require_session(drone_id).link_manager
    return {"primary_sysid": lm.primary_sysid, "vehicles": lm.list_vehicles_payload()}


@router.post("/drones/{drone_id}/vehicles/select")
async def drone_vehicle_select(drone_id: str, req: VehicleSelectRequest):
    lm = _require_session(drone_id).link_manager
    if not lm.select_primary(int(req.sysid)):
        raise HTTPException(status_code=400, detail="Unknown vehicle sysid")
    return {"status": "ok", "primary_sysid": lm.primary_sysid}


# ── per-drone: commands / mode ───────────────────────────────────────────────
@router.post("/drones/{drone_id}/command")
async def drone_command(drone_id: str, req: CommandRequest):
    lm = _require_session(drone_id).link_manager
    if not lm.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    out = await lm.send_command(
        lm.primary_sysid, lm.primary_compid, req.command,
        req.p1, req.p2, req.p3, req.p4, req.p5, req.p6, req.p7,
    )
    return {"status": "success" if out.get("accepted") else "failed", **out}


@router.post("/drones/{drone_id}/mode")
async def drone_set_mode(drone_id: str, req: ModeRequest):
    lm = _require_session(drone_id).link_manager
    if not lm.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    if lm.set_mode(lm.primary_sysid, req.mode):
        return {"status": "success"}
    raise HTTPException(status_code=500, detail="Failed to set mode")


# ── per-drone: mission ───────────────────────────────────────────────────────
@router.get("/drones/{drone_id}/mission")
async def drone_get_mission(drone_id: str, mission_type: str = "MISSION"):
    session = _require_session(drone_id)
    items = await session.mission_manager.download_mission(mission_type=mission_type)
    ts = session.mission_manager.transfer_status or {}
    if ts.get("ok") is False:
        raise HTTPException(status_code=500, detail={
            "error": "mission_download_failed",
            "mission_type": mission_type.upper(),
            "transfer": ts,
        })
    return {"items": [item.to_dict() for item in items], "mission_type": mission_type.upper()}


@router.post("/drones/{drone_id}/mission/upload")
async def drone_upload_mission(drone_id: str, request: MissionTransferRequest):
    session = _require_session(drone_id)
    success = await session.mission_manager.upload_mission(request.items, mission_type=request.mission_type)
    if success:
        return {"status": "success", "mission_type": request.mission_type.upper()}
    raise HTTPException(status_code=500, detail={
        "error": "mission_upload_failed",
        "mission_type": request.mission_type.upper(),
        "transfer": session.mission_manager.transfer_status,
    })


@router.get("/drones/{drone_id}/mission/transfer/status")
async def drone_mission_transfer_status(drone_id: str):
    return _require_session(drone_id).mission_manager.transfer_status


# ── per-drone: parameters ────────────────────────────────────────────────────
@router.post("/drones/{drone_id}/parameters/refresh")
async def drone_parameters_refresh(drone_id: str):
    session = _require_session(drone_id)
    if not session.link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    ok = await session.parameter_manager.fetch_all()
    return {"status": "success" if ok else "partial", "sync_status": session.parameter_manager.to_status()}


@router.get("/drones/{drone_id}/parameters/status")
async def drone_parameters_status(drone_id: str):
    return _require_session(drone_id).parameter_manager.to_status()


@router.post("/drones/{drone_id}/parameters/set")
async def drone_parameters_set(drone_id: str, req: ParameterSetRequest):
    session = _require_session(drone_id)
    if not session.link_manager.primary_sysid:
        raise HTTPException(status_code=500, detail="No vehicle connected")
    result = await session.parameter_manager.set_parameter_verified(req.param_id, req.param_value)
    if result.get("ok"):
        return {"status": "success", "value": result.get("value")}
    raise HTTPException(status_code=500, detail={
        "error": result.get("error", "Set parameter failed"),
        "rolled_back": result.get("rolled_back", False),
    })


# ── per-drone: connection profiles (improvement 1) ───────────────────────────
class ConnectionProfileCreate(BaseModel):
    name: str
    kind: str                                   # udp|tcp|serial|lte|wireguard|companion|sitl
    connection_string: str
    baudrate: int | None = None
    udp_forwarding: list[str] = []
    priority: int = 100
    metadata: dict = {}
    activate: bool = False


@router.get("/drones/{drone_id}/connection-profiles")
async def list_connection_profiles(drone_id: str):
    _require_session(drone_id)                   # 404 if the drone isn't registered
    repos = _require_repos()
    return {"profiles": await repos.connection_profiles.list(drone_id)}


@router.post("/drones/{drone_id}/connection-profiles", status_code=201)
async def add_connection_profile(drone_id: str, req: ConnectionProfileCreate):
    _require_session(drone_id)
    repos = _require_repos()
    if not await repos.allowlist.is_allowed(req.connection_string, org_id=_org_id, baudrate=req.baudrate):
        raise HTTPException(status_code=422,
                            detail=f"connection_string not permitted by allow-list: {req.connection_string!r}")
    try:
        return await repos.connection_profiles.add(
            drone_id=drone_id, org_id=_org_id, name=req.name, kind=req.kind,
            connection_string=req.connection_string, baudrate=req.baudrate,
            udp_forwarding=req.udp_forwarding or None, priority=req.priority,
            metadata=req.metadata or None, activate=req.activate,
        )
    except Exception as e:  # noqa: BLE001 — likely a UNIQUE(drone_id, name) clash
        raise HTTPException(status_code=409, detail=str(e))


@router.post("/drones/{drone_id}/connection-profiles/{profile_id}/activate")
async def activate_connection_profile(drone_id: str, profile_id: str):
    _require_session(drone_id)
    repos = _require_repos()
    profile = await repos.connection_profiles.activate(profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail=f"Unknown profile_id: {profile_id}")
    return profile


@router.delete("/drones/{drone_id}/connection-profiles/{profile_id}")
async def delete_connection_profile(drone_id: str, profile_id: str):
    _require_session(drone_id)
    repos = _require_repos()
    if not await repos.connection_profiles.delete(profile_id):
        raise HTTPException(status_code=404, detail=f"Unknown profile_id: {profile_id}")
    return {"status": "removed", "profile_id": profile_id}


# ── per-drone: capabilities (improvement 2) ──────────────────────────────────
class CapabilitySet(BaseModel):
    capability: str                              # rgb_camera|thermal_camera|rtk|payload|...
    present: bool = True
    spec: dict = {}


@router.get("/drones/{drone_id}/capabilities")
async def list_capabilities(drone_id: str):
    _require_session(drone_id)
    repos = _require_repos()
    return {"capabilities": await repos.capabilities.list(drone_id)}


@router.put("/drones/{drone_id}/capabilities")
async def set_capability(drone_id: str, req: CapabilitySet):
    _require_session(drone_id)
    repos = _require_repos()
    return await repos.capabilities.set(
        drone_id=drone_id, capability=req.capability, present=req.present, spec=req.spec or None,
    )


@router.delete("/drones/{drone_id}/capabilities/{capability}")
async def remove_capability(drone_id: str, capability: str):
    _require_session(drone_id)
    repos = _require_repos()
    if not await repos.capabilities.remove(drone_id=drone_id, capability=capability):
        raise HTTPException(status_code=404, detail=f"Capability not set: {capability}")
    return {"status": "removed", "capability": capability}


# ── per-drone: flight history (M4) ───────────────────────────────────────────
@router.get("/drones/{drone_id}/flights")
async def list_flights(drone_id: str, limit: int = 50):
    _require_session(drone_id)
    repos = _require_repos()
    flights = await repos.flights.list_for_drone(drone_id, limit=min(max(1, limit), 200))
    active = _flight_tracker.active_flight_id(drone_id) if _flight_tracker else None
    return {"flights": flights, "active_flight_id": active}


# ── per-drone: telemetry history track (M5) ──────────────────────────────────
@router.get("/drones/{drone_id}/telemetry/track")
async def telemetry_track(drone_id: str, t0: float | None = None, t1: float | None = None,
                          limit: int = 5000):
    _require_session(drone_id)
    repos = _require_repos()
    rows = await repos.telemetry.query_track(drone_id, t0=t0, t1=t1, limit=min(max(1, limit), 50000))
    return {"drone_id": drone_id, "count": len(rows), "track": rows}


# ── org settings & feature flags (improvements 4/5/6) ────────────────────────
class OrgSettingsUpdate(BaseModel):
    telemetry_persist_hz: float | None = None
    retention_telemetry_days: int | None = None
    retention_alerts_days: int | None = None
    retention_commands_days: int | None = None
    retention_recordings_days: int | None = None
    retention_logs_days: int | None = None


class FeatureFlagSet(BaseModel):
    flag: str
    enabled: bool = True
    value: dict = {}


@router.get("/org/settings")
async def get_org_settings():
    repos = _require_repos()
    settings = await repos.org.get_settings(_org_id)
    return {"org_id": _org_id, "settings": settings}


@router.put("/org/settings")
async def update_org_settings(req: OrgSettingsUpdate):
    repos = _require_repos()
    values = {k: v for k, v in req.model_dump().items() if v is not None}
    settings = await repos.org.upsert_settings(_org_id, **values)
    if _org_resolver is not None:
        _org_resolver.invalidate(_org_id)      # per-org rate/retention take effect promptly
    return {"org_id": _org_id, "settings": settings}


@router.get("/org/feature-flags")
async def list_feature_flags():
    repos = _require_repos()
    return {"org_id": _org_id, "flags": await repos.org.list_flags(_org_id)}


@router.put("/org/feature-flags")
async def set_feature_flag(req: FeatureFlagSet):
    repos = _require_repos()
    return await repos.org.set_flag(org_id=_org_id, flag=req.flag, enabled=req.enabled,
                                    value=req.value or None)


# ── per-drone: command audit history (M6) ────────────────────────────────────
@router.get("/drones/{drone_id}/commands")
async def list_command_audit(drone_id: str, limit: int = 100):
    _require_session(drone_id)
    repos = _require_repos()
    return {"commands": await repos.commands.list_for_drone(drone_id, limit=min(max(1, limit), 500))}


# ── mission templates / instances / runs (improvement 3) ─────────────────────
class MissionTemplateCreate(BaseModel):
    name: str
    definition: dict
    description: str | None = None
    version: int = 1


class MissionInstanceCreate(BaseModel):
    name: str
    template_id: str | None = None
    drone_id: str | None = None
    params: dict = {}
    status: str = "draft"


@router.get("/missions/templates")
async def list_mission_templates(include_archived: bool = False):
    repos = _require_repos()
    return {"templates": await repos.missions.list_templates(_org_id, include_archived=include_archived)}


@router.post("/missions/templates", status_code=201)
async def create_mission_template(req: MissionTemplateCreate):
    repos = _require_repos()
    return await repos.missions.create_template(
        org_id=_org_id, name=req.name, definition=req.definition,
        description=req.description, version=req.version,
    )


@router.delete("/missions/templates/{template_id}")
async def archive_mission_template(template_id: str):
    repos = _require_repos()
    if not await repos.missions.archive_template(template_id):
        raise HTTPException(status_code=404, detail=f"Unknown template_id: {template_id}")
    return {"status": "archived", "template_id": template_id}


@router.get("/missions/instances")
async def list_mission_instances(drone_id: str | None = None):
    repos = _require_repos()
    return {"instances": await repos.missions.list_instances(_org_id, drone_id=drone_id)}


@router.post("/missions/instances", status_code=201)
async def create_mission_instance(req: MissionInstanceCreate):
    repos = _require_repos()
    return await repos.missions.create_instance(
        org_id=_org_id, name=req.name, template_id=req.template_id,
        drone_id=req.drone_id, params=req.params or None, status=req.status,
    )


@router.get("/drones/{drone_id}/missions/runs")
async def list_mission_runs(drone_id: str, limit: int = 50):
    _require_session(drone_id)
    repos = _require_repos()
    return {"runs": await repos.missions.list_runs(drone_id=drone_id, limit=min(max(1, limit), 200))}


# ── alert rules (config; firing is Phase 8) ──────────────────────────────────
class AlertRuleCreate(BaseModel):
    name: str
    metric: str
    operator: str
    threshold: float | None = None
    severity: str = "warning"
    enabled: bool = True


@router.get("/alert-rules")
async def list_alert_rules():
    repos = _require_repos()
    return {"rules": await repos.alerts.list_rules(_org_id)}


@router.post("/alert-rules", status_code=201)
async def create_alert_rule(req: AlertRuleCreate):
    repos = _require_repos()
    return await repos.alerts.create_rule(
        org_id=_org_id, name=req.name, metric=req.metric, operator=req.operator,
        threshold=req.threshold, severity=req.severity, enabled=req.enabled,
    )


@router.delete("/alert-rules/{rule_id}")
async def delete_alert_rule(rule_id: str):
    repos = _require_repos()
    if not await repos.alerts.delete_rule(rule_id):
        raise HTTPException(status_code=404, detail=f"Unknown rule_id: {rule_id}")
    return {"status": "removed", "rule_id": rule_id}


@router.get("/alerts")
async def list_active_alerts():
    repos = _require_repos()
    return {"alerts": await repos.alerts.list_active(_org_id)}


# ── recordings metadata (object-store pointers) ──────────────────────────────
@router.get("/recordings")
async def list_recordings(drone_id: str | None = None, limit: int = 100):
    repos = _require_repos()
    return {"recordings": await repos.recordings.list(org_id=_org_id, drone_id=drone_id,
                                                      limit=min(max(1, limit), 500))}
