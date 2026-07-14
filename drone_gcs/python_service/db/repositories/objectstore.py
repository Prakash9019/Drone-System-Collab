"""Object storage abstraction (ADR-005) — blobs live here; the DB holds only a
pointer row (recordings table). Default driver is the local filesystem, matching
today's `recordings/` layout exactly (zero data migration). S3/MinIO is a driver
swap behind OBJECT_STORE_URL — never a caller change.
"""
from __future__ import annotations

import hashlib
import os
import shutil
from dataclasses import dataclass
from typing import BinaryIO, Optional


@dataclass
class ObjectStat:
    uri: str
    size_bytes: int
    checksum: Optional[str] = None


class FsObjectStore:
    """Filesystem driver. `uri` form is ``fs://<relpath>`` relative to `root`."""

    scheme = "fs"

    def __init__(self, root: str) -> None:
        self.root = os.path.abspath(root)
        os.makedirs(self.root, exist_ok=True)

    def _abspath(self, key_or_uri: str) -> str:
        rel = key_or_uri[5:] if key_or_uri.startswith("fs://") else key_or_uri
        rel = rel.lstrip("/")
        path = os.path.abspath(os.path.join(self.root, rel))
        # containment guard — never escape the store root (defence-in-depth vs. a
        # crafted key with ../ segments)
        if os.path.commonpath([self.root, path]) != self.root:
            raise ValueError(f"key escapes object store root: {key_or_uri!r}")
        return path

    def put_bytes(self, key: str, data: bytes) -> str:
        path = self._abspath(key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return f"fs://{key.lstrip('/')}"

    def put_file(self, key: str, src_path: str) -> str:
        path = self._abspath(key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        shutil.copyfile(src_path, path)
        return f"fs://{key.lstrip('/')}"

    def open(self, uri: str) -> BinaryIO:
        return open(self._abspath(uri), "rb")

    def exists(self, uri: str) -> bool:
        return os.path.exists(self._abspath(uri))

    def delete(self, uri: str) -> bool:
        path = self._abspath(uri)
        if os.path.exists(path):
            os.remove(path)
            return True
        return False

    def stat(self, uri: str) -> Optional[ObjectStat]:
        path = self._abspath(uri)
        if not os.path.exists(path):
            return None
        size = os.path.getsize(path)
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return ObjectStat(uri=uri, size_bytes=size, checksum=h.hexdigest())


def build_object_store(object_store_url: Optional[str], *, default_root: str) -> FsObjectStore:
    """Select a driver from OBJECT_STORE_URL. Absent or fs:// → filesystem.
    s3:// is the documented opt-in (boto3/minio) — not bundled by default."""
    if not object_store_url or object_store_url.startswith("fs://") or object_store_url == "fs":
        root = object_store_url[5:] if (object_store_url or "").startswith("fs://") else default_root
        return FsObjectStore(root or default_root)
    if object_store_url.startswith("s3://"):
        raise NotImplementedError(
            "S3/MinIO object store is opt-in; install boto3 and wire an S3 driver "
            "(ADR-005). Filesystem is the default."
        )
    raise ValueError(f"unsupported OBJECT_STORE_URL scheme: {object_store_url!r}")
