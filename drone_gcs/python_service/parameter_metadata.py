"""Optional parameter metadata (units, short descriptions) for the Params UI."""

from __future__ import annotations

import json
import logging
import os
from functools import lru_cache
from typing import Any, Dict

logger = logging.getLogger(__name__)

_DIR = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_JSON = os.path.join(_DIR, "param_metadata_common.json")


@lru_cache(maxsize=1)
def _load_file(path: str) -> Dict[str, Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return {str(k).upper(): dict(v) if isinstance(v, dict) else {"description": str(v)} for k, v in data.items()}
    except FileNotFoundError:
        logger.info("Parameter metadata file missing: %s", path)
    except Exception as e:
        logger.warning("Failed to load parameter metadata: %s", e)
    return {}


def get_metadata_map() -> Dict[str, Dict[str, Any]]:
    """Merge built-in JSON with optional user override PARAM_METADATA_JSON."""
    merged: Dict[str, Dict[str, Any]] = {}
    merged.update(_load_file(_DEFAULT_JSON))
    extra = os.environ.get("PARAM_METADATA_JSON", "").strip()
    if extra:
        merged.update(_load_file(os.path.expanduser(extra)))
    return merged


def lookup(param_id: str) -> Dict[str, Any]:
    pid = str(param_id).strip().upper()
    return dict(get_metadata_map().get(pid, {}))
