"""Fleet persistence layer (Phase 5B).

Python is the sole owner of the database (ADR-002). This package is the only
place in the codebase that imports SQLAlchemy / a DB driver (ADR-003): every
other module calls typed repository methods and exchanges plain dicts, exactly
as it did before persistence existed.

Nothing here runs unless ``FLEET_PERSISTENCE_ENABLED`` is set — the layer lands
dark so 5B is a zero-behaviour-change addition until explicitly flipped on.
"""
from db.settings import DBSettings, load_db_settings

__all__ = ["DBSettings", "load_db_settings"]
