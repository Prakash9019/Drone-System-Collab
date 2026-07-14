"""baseline — full fleet schema + dev seeds

Revision ID: 0001_baseline
Revises:
Create Date: 2026-07-11
"""
from __future__ import annotations

import time
import uuid

from alembic import op

from db.schema import (
    connection_allowlist,
    connection_profiles,
    drones,
    metadata,
    org_settings,
    organizations,
)

revision = "0001_baseline"
down_revision = None
branch_labels = None
depends_on = None

DEFAULT_ORG_ID = "default"
DEFAULT_DRONE_ID = "default"


def upgrade() -> None:
    bind = op.get_bind()
    # Single source of truth: create every table straight from the Core metadata,
    # so the migrated schema can never drift from db/schema.py.
    metadata.create_all(bind)

    now = time.time()

    bind.execute(organizations.insert().values(
        id=DEFAULT_ORG_ID, name="Default Organization", slug="default",
        created_at=now, metadata_json=None,
    ))
    bind.execute(org_settings.insert().values(org_id=DEFAULT_ORG_ID, updated_at=now))
    bind.execute(drones.insert().values(
        id=DEFAULT_DRONE_ID, org_id=DEFAULT_ORG_ID, name="default",
        connection_string="auto", baudrate=115200, auto_connect=0, created_at=now,
    ))
    bind.execute(connection_profiles.insert().values(
        id=uuid.uuid4().hex, drone_id=DEFAULT_DRONE_ID, org_id=DEFAULT_ORG_ID,
        name="default", kind="serial", connection_string="auto",
        priority=100, is_active=1, created_at=now,
    ))

    # Dev allow-list seeds — SITL/local ranges. Production tightens these.
    for row in (
        dict(scheme="tcp", host_pattern="127.0.0.1", port_min=5760, port_max=5900),
        dict(scheme="udp", host_pattern="127.0.0.1", port_min=14550, port_max=14650),
        dict(scheme="serial", device_glob="/dev/tty*"),
    ):
        bind.execute(connection_allowlist.insert().values(
            id=uuid.uuid4().hex, org_id=DEFAULT_ORG_ID, created_at=now, **row,
        ))


def downgrade() -> None:
    metadata.drop_all(op.get_bind())
