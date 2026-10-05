"""Supabase Storage driver. This is the ONLY file that talks to Supabase.

Uses the Supabase Storage REST API directly (no supabase-py dependency).
Both the classic JWT service_role key and the new ``sb_secret_...`` /
``sb_publishable_...`` keys are supported — they behave identically
when sent as both `apikey` and `Authorization: Bearer` headers.
"""
from __future__ import annotations
import hashlib
import logging
from typing import Optional

import httpx

from settings import settings

from .base import MediaStorage, StoredObject, StorageError

logger = logging.getLogger("forge.media_storage.supabase")


async def supabase_ready(timeout: float = 5.0) -> None:
    """Prove the configured storage API and both required buckets are usable."""
    headers = {
        "apikey": settings.supabase_service_role_key,
        "Authorization": f"Bearer {settings.supabase_service_role_key}",
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.get(f"{settings.supabase_url}/storage/v1/bucket", headers=headers)
    if response.status_code >= 300:
        raise StorageError(f"Supabase readiness failed [{response.status_code}]")
    payload = response.json()
    buckets = payload if isinstance(payload, list) else payload.get("data", [])
    present = {str(row.get("id") or row.get("name")) for row in buckets if isinstance(row, dict)}
    required = {settings.supabase_public_bucket, settings.supabase_private_bucket}
    missing = required - present
    if missing:
        raise StorageError("Supabase required bucket(s) missing: " + ", ".join(sorted(missing)))


class SupabaseStorageDriver(MediaStorage):
    def __init__(
        self,
        *,
        url: Optional[str] = None,
        service_role_key: Optional[str] = None,
        anon_key: Optional[str] = None,
        timeout: float = 30.0,
    ) -> None:
        self.url = (url or settings.supabase_url).rstrip("/")
        self.service_role_key = service_role_key or settings.supabase_service_role_key
        self.anon_key = anon_key or settings.supabase_anon_key
        self.timeout = timeout
        self._client: httpx.AsyncClient | None = None

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    # ---- internal helpers ------------------------------------------------

    def _headers(self, extra: Optional[dict] = None) -> dict:
        h = {
            "apikey": self.service_role_key,
            "Authorization": f"Bearer {self.service_role_key}",
        }
        if extra:
            h.update(extra)
        return h

    def _object_url(self, bucket: str, key: str) -> str:
        # Encode each path segment individually so slashes stay literal.
        from urllib.parse import quote
        parts = [quote(p, safe="") for p in key.split("/") if p]
        return f"{self.url}/storage/v1/object/{bucket}/{'/'.join(parts)}"

    async def _request(self, method: str, url: str, **kwargs) -> httpx.Response:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout)
        return await self._client.request(method, url, **kwargs)

    # ---- writes ----------------------------------------------------------

    async def upload(
        self,
        *,
        bucket: str,
        key: str,
        data: bytes,
        content_type: str,
        upsert: bool = True,
        cache_control: str = "public, max-age=31536000, immutable",
    ) -> StoredObject:
        headers = self._headers({
            "Content-Type": content_type,
            "x-upsert": "true" if upsert else "false",
            "cache-control": cache_control,
        })
        resp = await self._request(
            "POST" if not upsert else "PUT",
            self._object_url(bucket, key),
            content=data,
            headers=headers,
        )
        if resp.status_code >= 300:
            raise StorageError(f"Supabase upload failed [{resp.status_code}]: {resp.text}")
        sha1 = hashlib.sha1(data).hexdigest()
        public_url = self.get_public_url(bucket=bucket, key=key) if self._is_public(bucket) else None
        return StoredObject(
            bucket=bucket, key=key,
            public_url=public_url,
            size_bytes=len(data),
            content_type=content_type,
            sha1=sha1,
        )

    async def replace(
        self, *, bucket: str, key: str, data: bytes, content_type: str,
    ) -> StoredObject:
        # PUT with x-upsert:true replaces if present.
        return await self.upload(
            bucket=bucket, key=key, data=data, content_type=content_type, upsert=True,
        )

    async def delete(self, *, bucket: str, key: str) -> None:
        resp = await self._request(
            "DELETE", self._object_url(bucket, key), headers=self._headers(),
        )
        if resp.status_code == 404:
            return
        if resp.status_code >= 300:
            raise StorageError(f"Supabase delete failed [{resp.status_code}]: {resp.text}")

    # ---- reads -----------------------------------------------------------

    async def require_private_bucket(self, bucket: str) -> None:
        from urllib.parse import quote
        resp = await self._request(
            "GET", f"{self.url}/storage/v1/bucket/{quote(bucket, safe='')}",
            headers=self._headers(),
        )
        if resp.status_code != 200 or resp.json().get("public") is not False:
            raise StorageError("Private bucket visibility could not be verified")

    async def download(self, *, bucket: str, key: str) -> bytes:
        resp = await self._request("GET", self._object_url(bucket, key), headers=self._headers())
        if resp.status_code >= 300:
            raise StorageError(f"Supabase download failed [{resp.status_code}]: {resp.text}")
        return resp.content

    async def exists(self, *, bucket: str, key: str) -> bool:
        # HEAD isn't officially documented — use the info endpoint instead.
        info_url = f"{self.url}/storage/v1/object/info/{'authenticated' if not self._is_public(bucket) else 'public'}/{bucket}/{key}"
        resp = await self._request("GET", info_url, headers=self._headers())
        return resp.status_code == 200

    def get_public_url(self, *, bucket: str, key: str) -> str:
        from urllib.parse import quote
        parts = [quote(p, safe="") for p in key.split("/") if p]
        return f"{self.url}/storage/v1/object/public/{bucket}/{'/'.join(parts)}"

    async def get_signed_url(
        self, *, bucket: str, key: str, expires_in: int = 3600,
    ) -> str:
        sign_url = f"{self.url}/storage/v1/object/sign/{bucket}/{key}"
        resp = await self._request(
            "POST", sign_url,
            headers=self._headers({"Content-Type": "application/json"}),
            json={"expiresIn": expires_in},
        )
        if resp.status_code >= 300:
            raise StorageError(f"Supabase sign failed [{resp.status_code}]: {resp.text}")
        signed_path = resp.json().get("signedURL") or resp.json().get("signedUrl")
        if not signed_path:
            raise StorageError(f"Supabase sign returned no URL: {resp.text}")
        # signedURL is a relative path — prefix with base.
        if signed_path.startswith("http"):
            return signed_path
        return f"{self.url}/storage/v1{signed_path if signed_path.startswith('/') else '/' + signed_path}"

    # ---- helpers ---------------------------------------------------------

    _PUBLIC_BUCKETS: set[str] = set()

    def _is_public(self, bucket: str) -> bool:
        # Cache bucket visibility on first check
        if bucket in self._PUBLIC_BUCKETS:
            return True
        pub = settings.supabase_public_bucket
        if bucket == pub:
            self._PUBLIC_BUCKETS.add(bucket)
            return True
        return False
