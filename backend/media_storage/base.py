"""MediaStorage interface. Zero provider details leak into this module."""
from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator, Optional


class StorageError(Exception):
    """Raised by any MediaStorage driver when an operation fails."""


@dataclass
class StoredObject:
    """Metadata about a file living behind the storage layer."""
    bucket: str          # "forge-products" | "forge-private"
    key: str             # object path inside the bucket, e.g. "vitra/family-xyz/hero.png"
    public_url: Optional[str]   # None for private buckets
    size_bytes: int
    content_type: str
    sha1: str            # 40-char hex digest of the raw bytes


class MediaStorage(ABC):
    """Provider-agnostic media storage interface.

    Business code only ever sees this class. Driver-specific concerns
    (authentication headers, SDK objects, retry policies) live inside
    concrete implementations.
    """

    # ---- writes ----------------------------------------------------------

    @abstractmethod
    async def upload(
        self,
        *,
        bucket: str,
        key: str,
        data: bytes,
        content_type: str,
        upsert: bool = True,
        cache_control: str = "public, max-age=31536000, immutable",
    ) -> StoredObject: ...

    @abstractmethod
    async def replace(
        self, *, bucket: str, key: str, data: bytes, content_type: str,
    ) -> StoredObject: ...

    @abstractmethod
    async def delete(self, *, bucket: str, key: str) -> None: ...

    # ---- reads -----------------------------------------------------------

    async def require_private_bucket(self, bucket: str) -> None:
        """Fail closed unless the provider proves the bucket is private."""
        raise StorageError("Storage driver cannot verify private bucket visibility")

    async def iter_objects(self, *, bucket: str, prefix: str = "", page_size: int = 1000) -> AsyncIterator[dict]:
        """Enumerate current objects, including nested folders, or fail closed."""
        raise StorageError("Storage driver cannot enumerate objects")
        yield  # pragma: no cover — makes the interface an async iterator

    @abstractmethod
    async def download(self, *, bucket: str, key: str) -> bytes:
        """Return raw object bytes using the storage provider credentials."""

    @abstractmethod
    async def exists(self, *, bucket: str, key: str) -> bool: ...

    @abstractmethod
    def get_public_url(self, *, bucket: str, key: str) -> str:
        """Return the (unsigned) public URL. Only valid for public buckets."""

    @abstractmethod
    async def get_signed_url(
        self, *, bucket: str, key: str, expires_in: int = 3600,
    ) -> str:
        """Return a short-lived signed URL. Works for private buckets too."""
