"""Structured JSON logging with correlation IDs (Phase 5A).

Installs a JSON formatter on the root logger so every line is one machine-parseable
object: {ts, level, logger, msg, request_id?, drone_id?, ...}. Correlation IDs live
in contextvars, so they propagate through async handlers automatically and are
stamped onto every log record emitted while that context is active.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from contextvars import ContextVar
from typing import Optional

# Correlation context — set by the HTTP middleware / per-drone code paths.
request_id_var: ContextVar[Optional[str]] = ContextVar("request_id", default=None)
drone_id_var: ContextVar[Optional[str]] = ContextVar("drone_id", default=None)

# Standard LogRecord attributes we must NOT re-emit as "extra" fields.
_RESERVED = set(logging.makeLogRecord({}).__dict__.keys()) | {"message", "asctime", "taskName"}


def new_request_id() -> str:
    return uuid.uuid4().hex


class JsonFormatter(logging.Formatter):
    def __init__(self, service: str = "drone-gcs-python") -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "service": self.service,
            "logger": record.name,
            "msg": record.getMessage(),
        }

        rid = request_id_var.get()
        if rid:
            payload["request_id"] = rid
        did = drone_id_var.get()
        if did:
            payload["drone_id"] = did

        # Anything passed via logging's `extra=` lands as record attributes.
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value

        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)

        try:
            return json.dumps(payload, default=str)
        except (TypeError, ValueError):
            return json.dumps({
                "ts": payload["ts"], "level": payload["level"],
                "service": self.service, "logger": record.name,
                "msg": record.getMessage(), "log_error": "unserializable_fields",
            })


def setup_logging(level: str = "info", service: str = "drone-gcs-python") -> None:
    """Replace root handlers with a single JSON stdout handler at `level`."""
    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter(service=service))
    # Swap in our handler; drop any pre-existing basicConfig handlers.
    for h in list(root.handlers):
        root.removeHandler(h)
    root.addHandler(handler)
