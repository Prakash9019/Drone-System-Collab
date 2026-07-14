"""RepositoryHub — one object that owns every repository, constructed from the
async sessionmaker. main.py wires a single hub and hands it to the registry,
telemetry publisher, and command manager.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from db.repositories.alerts_repo import AlertsRepo
from db.repositories.allowlist_repo import AllowlistRepo
from db.repositories.capabilities_repo import CapabilitiesRepo
from db.repositories.commands_repo import CommandsRepo
from db.repositories.connection_profiles_repo import ConnectionProfilesRepo
from db.repositories.drones_repo import DronesRepo
from db.repositories.flights_repo import FlightsRepo
from db.repositories.missions_repo import MissionsRepo
from db.repositories.org_repo import OrgRepo
from db.repositories.provisioning_repo import ProvisioningRepo
from db.repositories.recordings_repo import RecordingsRepo
from db.repositories.retention_repo import RetentionRepo
from db.repositories.telemetry_repo import TelemetryRepo


class RepositoryHub:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession], *, object_store=None) -> None:
        self._sm = sessionmaker
        self.object_store = object_store
        self.drones = DronesRepo(sessionmaker)
        self.allowlist = AllowlistRepo(sessionmaker)
        self.connection_profiles = ConnectionProfilesRepo(sessionmaker)
        self.capabilities = CapabilitiesRepo(sessionmaker)
        self.flights = FlightsRepo(sessionmaker)
        self.telemetry = TelemetryRepo(sessionmaker)
        self.org = OrgRepo(sessionmaker)
        self.retention = RetentionRepo(sessionmaker)
        self.commands = CommandsRepo(sessionmaker)
        self.missions = MissionsRepo(sessionmaker)
        self.alerts = AlertsRepo(sessionmaker)
        self.provisioning = ProvisioningRepo(sessionmaker)
        self.recordings = RecordingsRepo(sessionmaker, object_store=object_store)


def build_hub(sessionmaker: async_sessionmaker[AsyncSession], *, object_store=None) -> RepositoryHub:
    return RepositoryHub(sessionmaker, object_store=object_store)
