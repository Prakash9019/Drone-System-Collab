"""Repository layer — the ONLY code (besides db/) that touches SQLAlchemy.

Domain modules (session registry, telemetry publisher, command manager) call
typed async methods here and receive plain dicts, exactly as they exchanged
data before persistence existed (ADR-003). Dialect divergences never leak past
this package.
"""
from db.repositories.hub import RepositoryHub, build_hub

__all__ = ["RepositoryHub", "build_hub"]
