"""Alembic environment — resolves the DB URL from DATABASE_URL at runtime and
targets db.schema.metadata, so one migration set drives SQLite and PostgreSQL.

Migrations run synchronously (Alembic's model); the app runs async. The sync
URL is derived from the async URL by DBSettings.sync_url().
"""
from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from db.schema import metadata
from db.settings import load_db_settings

config = context.config

if config.config_file_name is not None:
    # disable_existing_loggers=False: when migrations run programmatically at app
    # boot (db/migrate.py), fileConfig must NOT clobber the app's already-installed
    # structured JSON loggers — otherwise every log line after the first migration
    # goes silent.
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = metadata

# Prefer a URL already injected by the programmatic runner (db/migrate.py sets
# it on the Config); only fall back to the environment for a bare `alembic` CLI
# invocation. Re-reading os.environ unconditionally would ignore the caller's URL.
_url = config.get_main_option("sqlalchemy.url")
if not _url:
    _url = load_db_settings().sync_url()
    config.set_main_option("sqlalchemy.url", _url)

_is_sqlite = _url.startswith("sqlite")


def run_migrations_offline() -> None:
    context.configure(
        url=_url,
        target_metadata=target_metadata,
        literal_binds=True,
        render_as_batch=_is_sqlite,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=_is_sqlite,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
