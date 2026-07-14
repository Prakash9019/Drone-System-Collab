"""The fleet schema — one SQLAlchemy Core ``MetaData`` targeting both SQLite
(default) and PostgreSQL from a single definition (ADR-003, ADR-004).

Conventions (Phase 5B doc §4):
- Entity PKs that exist before insert and cross tiers are ``TEXT`` uuid4 hex.
- High-volume append tables (telemetry_history, commands_audit, alerts) use
  ``BigInteger`` autoincrement PKs — never referenced externally.
- Timestamps are ``Float`` epoch seconds (matches ``time.time()`` everywhere in
  the code) — one canonical ``*_at`` column, no TIMESTAMP type, no tz ambiguity.
- JSON blobs use SQLAlchemy ``JSON`` (TEXT on SQLite, JSON on Postgres); the
  repository layer reads/writes whole objects, never DB-side JSON-path queries.
- 0/1 flags use ``Integer`` to mirror the DDL and the code's existing int usage.
"""
from __future__ import annotations

from sqlalchemy import (
    BigInteger,
    Column,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    MetaData,
    String,
    Table,
    UniqueConstraint,
    text,
)

metadata = MetaData()

# High-volume autoincrement PK: BIGINT on Postgres, but INTEGER on SQLite so it
# aliases ROWID and actually autoincrements (a plain BIGINT PK does not on
# SQLite). One definition, correct on both dialects.
AutoPK = BigInteger().with_variant(Integer, "sqlite")


# ── tenancy ──────────────────────────────────────────────────────────────────
organizations = Table(
    "organizations", metadata,
    Column("id", String, primary_key=True),
    Column("name", String, nullable=False),
    Column("slug", String, nullable=False, unique=True),
    Column("created_at", Float, nullable=False),
    Column("metadata_json", JSON),
)

users = Table(
    "users", metadata,
    Column("id", String, primary_key=True),
    Column("org_id", String, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False),
    Column("email", String, nullable=False),
    Column("display_name", String),
    Column("role", String, nullable=False, server_default=text("'operator'")),
    Column("password_hash", String),
    Column("created_at", Float, nullable=False),
    Column("disabled_at", Float),
    UniqueConstraint("org_id", "email", name="uq_users_org_email"),
)

# Per-org operational policy (improvements 4 & 5): telemetry persist rate +
# retention windows. NULL column → fall back to the env/global default.
org_settings = Table(
    "org_settings", metadata,
    Column("org_id", String, ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True),
    Column("telemetry_persist_hz", Float),
    Column("retention_telemetry_days", Integer),
    Column("retention_alerts_days", Integer),
    Column("retention_commands_days", Integer),
    Column("retention_recordings_days", Integer),
    Column("retention_logs_days", Integer),
    Column("updated_at", Float),
)

# Product tiers / entitlements as rows (improvement 6) — new tier = new row.
organization_feature_flags = Table(
    "organization_feature_flags", metadata,
    Column("id", String, primary_key=True),
    Column("org_id", String, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
    Column("flag", String, nullable=False),
    Column("enabled", Integer, nullable=False, server_default=text("0")),
    Column("value", JSON),
    Column("updated_at", Float),
    UniqueConstraint("org_id", "flag", name="uq_feature_flag_org"),
    Index("ix_feature_flags_org", "org_id"),
)


# ── drones ───────────────────────────────────────────────────────────────────
drones = Table(
    "drones", metadata,
    Column("id", String, primary_key=True),               # == drone_id
    Column("org_id", String, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False),
    Column("name", String, nullable=False),
    Column("connection_string", String, nullable=False, server_default=text("'auto'")),  # mirrors active profile
    Column("baudrate", Integer, nullable=False, server_default=text("115200")),
    Column("udp_forwarding", JSON),
    Column("auto_connect", Integer, nullable=False, server_default=text("0")),
    Column("metadata_json", JSON),
    Column("last_seen_at", Float),
    Column("last_conn_state", String),
    Column("primary_sysid", Integer),
    Column("created_at", Float, nullable=False),
    Column("archived_at", Float),
    UniqueConstraint("org_id", "name", name="uq_drones_org_name"),
    Index("ix_drones_org", "org_id"),
    Index("ix_drones_org_archived", "org_id", "archived_at"),
)

drone_credentials = Table(
    "drone_credentials", metadata,
    Column("drone_id", String, ForeignKey("drones.id", ondelete="CASCADE"), primary_key=True),
    Column("secret_hash", String, nullable=False),
    Column("issued_at", Float, nullable=False),
    Column("rotated_at", Float),
    Column("revoked_at", Float),
)

# Per-drone multi-transport (improvement 1). Exactly one active per drone,
# enforced by the repository; drones.connection_string mirrors the active one.
connection_profiles = Table(
    "connection_profiles", metadata,
    Column("id", String, primary_key=True),
    Column("drone_id", String, ForeignKey("drones.id", ondelete="CASCADE"), nullable=False),
    Column("org_id", String, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False),
    Column("name", String, nullable=False),
    Column("kind", String, nullable=False),               # udp|tcp|serial|lte|wireguard|companion|sitl
    Column("connection_string", String, nullable=False),
    Column("baudrate", Integer),
    Column("udp_forwarding", JSON),
    Column("priority", Integer, nullable=False, server_default=text("100")),
    Column("is_active", Integer, nullable=False, server_default=text("0")),
    Column("metadata_json", JSON),
    Column("created_at", Float, nullable=False),
    UniqueConstraint("drone_id", "name", name="uq_conn_profile_drone_name"),
    Index("ix_conn_profiles_drone", "drone_id"),
    Index("ix_conn_profiles_active", "drone_id", unique=False, sqlite_where=text("is_active = 1"),
          postgresql_where=text("is_active = 1")),
)

# Installed hardware / supported features (improvement 2) — open vocabulary.
drone_capabilities = Table(
    "drone_capabilities", metadata,
    Column("id", String, primary_key=True),
    Column("drone_id", String, ForeignKey("drones.id", ondelete="CASCADE"), nullable=False),
    Column("capability", String, nullable=False),         # rgb_camera|thermal_camera|rtk|payload|...
    Column("present", Integer, nullable=False, server_default=text("1")),
    Column("spec", JSON),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float),
    UniqueConstraint("drone_id", "capability", name="uq_capability_drone"),
    Index("ix_capabilities_drone", "drone_id"),
    Index("ix_capabilities_kind", "capability"),
)


# ── flights & telemetry ──────────────────────────────────────────────────────
flights = Table(
    "flights", metadata,
    Column("id", String, primary_key=True),
    Column("drone_id", String, ForeignKey("drones.id", ondelete="RESTRICT"), nullable=False),
    Column("org_id", String, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False),
    Column("sysid", Integer),
    Column("armed_at", Float, nullable=False),
    Column("disarmed_at", Float),
    Column("duration_s", Float),
    Column("start_mode", String),
    Column("max_alt_rel", Float),
    Column("distance_m", Float),
    Column("start_lat", Float),
    Column("start_lon", Float),
    Column("end_lat", Float),
    Column("end_lon", Float),
    Column("end_reason", String),                         # disarm|link_lost|timeout|shutdown
    Column("retention_hold", Integer, nullable=False, server_default=text("0")),
    Column("created_at", Float, nullable=False),
    Index("ix_flights_drone_armed", "drone_id", "armed_at"),
    Index("ix_flights_org_armed", "org_id", "armed_at"),
    Index("ix_flights_inflight", "drone_id", sqlite_where=text("disarmed_at IS NULL"),
          postgresql_where=text("disarmed_at IS NULL")),
)

telemetry_history = Table(
    "telemetry_history", metadata,
    Column("id", AutoPK, primary_key=True, autoincrement=True),
    Column("drone_id", String, ForeignKey("drones.id", ondelete="RESTRICT"), nullable=False),
    Column("flight_id", String, ForeignKey("flights.id", ondelete="SET NULL")),
    Column("sysid", Integer, nullable=False),
    Column("recorded_at", Float, nullable=False),
    Column("lat", Float),
    Column("lon", Float),
    Column("alt_rel", Float),
    Column("alt_amsl", Float),
    Column("heading", Float),
    Column("groundspeed", Float),
    Column("batt_voltage", Float),
    Column("batt_remaining", Integer),
    Column("mode", String),
    Column("armed", Integer),
    Column("gps_fix", Integer),
    Column("satellites", Integer),
    Column("sensors", JSON),
    Index("ix_telemetry_drone_time", "drone_id", "recorded_at"),
    Index("ix_telemetry_flight_time", "flight_id", "recorded_at"),
)


# ── audit ────────────────────────────────────────────────────────────────────
commands_audit = Table(
    "commands_audit", metadata,
    Column("id", AutoPK, primary_key=True, autoincrement=True),
    Column("drone_id", String, ForeignKey("drones.id", ondelete="RESTRICT"), nullable=False),
    Column("org_id", String, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False),
    Column("operator_id", String, ForeignKey("users.id", ondelete="SET NULL")),
    Column("flight_id", String, ForeignKey("flights.id", ondelete="SET NULL")),
    Column("sysid", Integer, nullable=False),
    Column("command", Integer, nullable=False),
    Column("params", JSON),
    Column("issued_at", Float, nullable=False),
    Column("result", Integer),
    Column("result_text", String),
    Column("reason", String),
    Column("source_route", String),
    Index("ix_commands_drone_time", "drone_id", "issued_at"),
    Index("ix_commands_operator_time", "operator_id", "issued_at"),
)


# ── alerts (config + fired instances; firing logic is Phase 8) ────────────────
alert_rules = Table(
    "alert_rules", metadata,
    Column("id", String, primary_key=True),
    Column("org_id", String, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False),
    Column("name", String, nullable=False),
    Column("metric", String, nullable=False),
    Column("operator", String, nullable=False),
    Column("threshold", Float),
    Column("severity", String, nullable=False, server_default=text("'warning'")),
    Column("enabled", Integer, nullable=False, server_default=text("1")),
    Column("created_at", Float, nullable=False),
)

alerts = Table(
    "alerts", metadata,
    Column("id", AutoPK, primary_key=True, autoincrement=True),
    Column("org_id", String, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False),
    Column("alert_rule_id", String, ForeignKey("alert_rules.id", ondelete="SET NULL")),
    Column("drone_id", String, ForeignKey("drones.id", ondelete="SET NULL")),
    Column("flight_id", String, ForeignKey("flights.id", ondelete="SET NULL")),
    Column("severity", String, nullable=False),
    Column("message", String, nullable=False),
    Column("triggered_at", Float, nullable=False),
    Column("cleared_at", Float),
    Column("context", JSON),
    Index("ix_alerts_org_time", "org_id", "triggered_at"),
    Index("ix_alerts_active", "org_id", sqlite_where=text("cleared_at IS NULL"),
          postgresql_where=text("cleared_at IS NULL")),
)


# ── missions (improvement 3): definition / instance / execution history ───────
mission_templates = Table(
    "mission_templates", metadata,
    Column("id", String, primary_key=True),
    Column("org_id", String, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False),
    Column("name", String, nullable=False),
    Column("description", String),
    Column("version", Integer, nullable=False, server_default=text("1")),
    Column("definition", JSON, nullable=False),
    Column("created_by", String, ForeignKey("users.id", ondelete="SET NULL")),
    Column("created_at", Float, nullable=False),
    Column("archived_at", Float),
    UniqueConstraint("org_id", "name", "version", name="uq_mission_template_ver"),
    Index("ix_mission_templates_org_name", "org_id", "name"),
)

mission_instances = Table(
    "mission_instances", metadata,
    Column("id", String, primary_key=True),
    Column("org_id", String, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False),
    Column("template_id", String, ForeignKey("mission_templates.id", ondelete="SET NULL")),
    Column("drone_id", String, ForeignKey("drones.id", ondelete="SET NULL")),
    Column("name", String, nullable=False),
    Column("params", JSON),
    Column("status", String, nullable=False, server_default=text("'draft'")),
    Column("created_by", String, ForeignKey("users.id", ondelete="SET NULL")),
    Column("created_at", Float, nullable=False),
    Column("archived_at", Float),
)

mission_runs = Table(
    "mission_runs", metadata,
    Column("id", String, primary_key=True),
    Column("org_id", String, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False),
    Column("instance_id", String, ForeignKey("mission_instances.id", ondelete="SET NULL")),
    Column("template_id", String, ForeignKey("mission_templates.id", ondelete="SET NULL")),
    Column("drone_id", String, ForeignKey("drones.id", ondelete="RESTRICT"), nullable=False),
    Column("flight_id", String, ForeignKey("flights.id", ondelete="SET NULL")),
    Column("started_at", Float, nullable=False),
    Column("ended_at", Float),
    Column("outcome", String),
    Column("progress", JSON),
    Column("created_at", Float, nullable=False),
    Index("ix_mission_runs_drone_time", "drone_id", "started_at"),
    Index("ix_mission_runs_flight", "flight_id"),
)


# ── supporting ───────────────────────────────────────────────────────────────
provisioning_tokens = Table(
    "provisioning_tokens", metadata,
    Column("id", String, primary_key=True),
    Column("org_id", String, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False),
    Column("token_hash", String, nullable=False, unique=True),
    Column("expires_at", Float),
    Column("used_at", Float),
    Column("created_drone_id", String, ForeignKey("drones.id", ondelete="SET NULL")),
    Column("created_at", Float, nullable=False),
)

# Closes F2 (SSRF-class dial-out): every connection_string is matched here
# before it reaches mavutil.mavlink_connection().
connection_allowlist = Table(
    "connection_allowlist", metadata,
    Column("id", String, primary_key=True),
    Column("org_id", String, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False),
    Column("scheme", String, nullable=False),             # tcp|udp|serial
    Column("host_pattern", String),
    Column("port_min", Integer),
    Column("port_max", Integer),
    Column("device_glob", String),
    Column("created_at", Float, nullable=False),
    Index("ix_allowlist_org", "org_id"),
)

recordings = Table(
    "recordings", metadata,
    Column("id", String, primary_key=True),
    Column("org_id", String, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False),
    Column("drone_id", String, ForeignKey("drones.id", ondelete="SET NULL")),
    Column("flight_id", String, ForeignKey("flights.id", ondelete="SET NULL")),
    Column("backend", String, nullable=False),            # fs | s3
    Column("uri", String, nullable=False),
    Column("size_bytes", BigInteger),
    Column("duration_s", Float),
    Column("checksum", String),
    Column("started_at", Float, nullable=False),
    Column("created_at", Float, nullable=False),
    Index("ix_recordings_drone", "drone_id"),
    Index("ix_recordings_flight", "flight_id"),
)


ALL_TABLES = tuple(metadata.tables.keys())
