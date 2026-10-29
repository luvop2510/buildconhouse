"""Cloudflare R2 through its S3 API; blocking SDK calls run off the event loop.

Bucket names remain the existing logical names so stored Mongo references and
private backup receipts remain valid. Only the public bucket has a public URL.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
from urllib.parse import quote

import boto3
import httpx
from botocore.config import Config
from botocore.exceptions import ClientError

from settings import settings
from .base import MediaStorage, StoredObject, StorageError
from services.product_image_variants import MIN_BYTES, PREFIX, WIDTHS, create_image_variants, variant_key

logger = logging.getLogger(__name__)
VISIBILITY_TIMEOUT_SECONDS = 5.0


class R2StorageDriver(MediaStorage):
    def __init__(self, *, cfg=None, client=None):
        self.cfg = cfg or settings
        self._variant_slot = asyncio.Semaphore(1)
        self._variant_jobs: set[asyncio.Task] = set()
        self._variant_sources: dict[asyncio.Task, tuple[str, str]] = {}
        self._private_checks: dict[str, asyncio.Task] = {}
        self._client = client or boto3.client(
            "s3", endpoint_url=f"https://{self.cfg.r2_account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=self.cfg.r2_access_key_id,
            aws_secret_access_key=self.cfg.r2_secret_access_key, region_name="auto",
            config=Config(signature_version="s3v4", connect_timeout=5, read_timeout=30, max_pool_connections=16,
                          retries={"mode": "standard", "max_attempts": 3},
                          s3={"addressing_style": "path"}),
        )

    def _scope(self, bucket, key=None):
        if bucket not in {self.cfg.supabase_public_bucket, self.cfg.supabase_private_bucket}:
            raise StorageError("Unconfigured R2 bucket")
        if key is not None and (not isinstance(key, str) or not key
                or any(p in {"", ".", ".."} for p in key.split("/"))
                or any(c in key for c in "\0\r\n")):
            raise StorageError("Unsafe R2 object key")

    async def _call(self, operation, **kwargs):
        try:
            return await asyncio.to_thread(getattr(self._client, operation), **kwargs)
        except Exception as exc:
            # Never echo provider bodies, access keys, signed URLs or object data.
            raise StorageError(f"R2 {operation} failed ({type(exc).__name__})") from exc

    async def close(self):
        if self._private_checks:
            await asyncio.gather(*self._private_checks.values(), return_exceptions=True)
        if self._variant_jobs:
            await asyncio.gather(*self._variant_jobs, return_exceptions=True)
        await asyncio.to_thread(self._client.close)

    async def upload(self, *, bucket, key, data, content_type, upsert=True,
                     cache_control="public, max-age=31536000, immutable"):
        self._scope(bucket, key)
        public = bucket == self.cfg.supabase_public_bucket
        args = dict(Bucket=bucket, Key=key, Body=data, ContentType=content_type,
                    CacheControl=cache_control if public else "private, no-store",
                    StorageClass="STANDARD")
        if not upsert:
            args["IfNoneMatch"] = "*"
        await self._call("put_object", **args)
        if public and not key.startswith(PREFIX):
            await self.publish_image_variants(bucket=bucket, key=key, data=data, content_type=content_type, wait=False)
        return StoredObject(bucket=bucket, key=key,
                            public_url=self.get_public_url(bucket=bucket, key=key) if public else None,
                            size_bytes=len(data), content_type=content_type,
                            sha1=hashlib.sha1(data).hexdigest())

    async def publish_image_variants(self, *, bucket, key, data, content_type, wait=True):
        """Optional display work cannot fail an acknowledged original upload.

        One encoder per driver bounds raster memory. Busy uploads retain the
        original fallback; the resumable backfill can fill missing derivatives.
        """
        self._scope(bucket, key)
        if (bucket != self.cfg.supabase_public_bucket or key.startswith(PREFIX)
                or len(data) < MIN_BYTES or content_type not in {"image/png", "image/jpeg", "image/webp"}):
            return 0
        try:
            await asyncio.wait_for(self._variant_slot.acquire(), timeout=0.05)
        except TimeoutError:
            return 0
        async def publish():
            try:
                variants = await asyncio.to_thread(create_image_variants, data, content_type)
                # At most two writes in flight; these have independent immutable keys.
                entries = list(variants.items())
                for start in range(0, len(entries), 2):
                    results = await asyncio.gather(*(self._call("put_object", Bucket=bucket,
                        Key=variant_key(key, width), Body=encoded, ContentType="image/webp",
                        CacheControl="public, max-age=31536000, immutable", StorageClass="STANDARD")
                        for width, encoded in entries[start:start + 2]), return_exceptions=True)
                    for result in results:
                        if isinstance(result, Exception):
                            raise result
                return len(entries)
            except Exception as error:
                logger.warning("Optional R2 image variants unavailable (%s)", type(error).__name__)
                return 0
            finally:
                self._variant_slot.release()
        # Cancellation of an HTTP request must not release encoder capacity
        # while a blocking Pillow/SDK thread is still running.
        job = asyncio.create_task(publish())
        self._variant_jobs.add(job)
        self._variant_sources[job] = (bucket, key)
        job.add_done_callback(self._variant_jobs.discard)
        job.add_done_callback(lambda task: self._variant_sources.pop(task, None))
        return await asyncio.shield(job) if wait else 0

    async def replace(self, *, bucket, key, data, content_type):
        return await self.upload(bucket=bucket, key=key, data=data, content_type=content_type)

    async def delete(self, *, bucket, key):
        self._scope(bucket, key)
        async def remove():
            await self._call("delete_object", Bucket=bucket, Key=key)
            if bucket == self.cfg.supabase_public_bucket and not key.startswith(PREFIX):
                # Failed metadata registration may delete during encoding.
                pending = [job for job, source in self._variant_sources.items() if source == (bucket, key)]
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)
                result = await self._call("delete_objects", Bucket=bucket,
                    Delete={"Objects": [{"Key": variant_key(key, width)} for width in WIDTHS], "Quiet": True})
                if result.get("Errors"):
                    raise StorageError("R2 image derivative cleanup failed")
        # Cancellation cannot abandon cleanup after the original is removed.
        job = asyncio.create_task(remove())
        self._variant_jobs.add(job)
        job.add_done_callback(self._variant_jobs.discard)
        await asyncio.shield(job)

    async def download(self, *, bucket, key):
        self._scope(bucket, key)
        response = await self._call("get_object", Bucket=bucket, Key=key)
        body = response["Body"]
        try:
            return await asyncio.to_thread(body.read)
        except Exception as exc:
            raise StorageError("R2 download body failed") from exc
        finally:
            await asyncio.to_thread(body.close)

    async def exists(self, *, bucket, key):
        self._scope(bucket, key)
        try:
            await asyncio.to_thread(self._client.head_object, Bucket=bucket, Key=key)
            return True
        except ClientError as exc:
            if exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 404:
                return False
            raise StorageError("R2 object lookup failed") from exc
        except Exception as exc:
            raise StorageError("R2 object lookup failed") from exc

    def get_public_url(self, *, bucket, key):
        self._scope(bucket, key)
        if bucket != self.cfg.supabase_public_bucket:
            raise StorageError("Private R2 objects have no public URL")
        return self.cfg.r2_public_url.rstrip("/") + "/" + quote(key, safe="/")

    async def get_signed_url(self, *, bucket, key, expires_in=3600):
        self._scope(bucket, key)
        if type(expires_in) is not int or not 1 <= expires_in <= 604800:
            raise ValueError("Signed URL expiry must be between 1 and 604800 seconds")
        return await self._call("generate_presigned_url", ClientMethod="get_object",
                                Params={"Bucket": bucket, "Key": key}, ExpiresIn=expires_in)

    async def iter_objects(self, *, bucket, prefix="", page_size=1000):
        self._scope(bucket)
        if type(page_size) is not int or not 1 <= page_size <= 1000:
            raise ValueError("Invalid storage page size")
        token, tokens, seen = None, set(), set()
        while True:
            args = dict(Bucket=bucket, Prefix=prefix, MaxKeys=page_size)
            if token:
                args["ContinuationToken"] = token
            page = await self._call("list_objects_v2", **args)
            for row in page.get("Contents", []):
                key = row["Key"]
                self._scope(bucket, key)
                if key in seen or not key.startswith(prefix):
                    raise StorageError("Repeated or out-of-scope R2 inventory key")
                seen.add(key)
                # ListObjects does not include MIME. HEAD is required for an
                # independently verified, restorable inventory.
                info = await self._call("head_object", Bucket=bucket, Key=key)
                yield {"bucket": bucket, "key": key, "size_bytes": info["ContentLength"],
                       "content_type": info.get("ContentType", "application/octet-stream"),
                       "etag": info.get("ETag"), "updated_at": str(info.get("LastModified"))}
            if not page.get("IsTruncated"):
                break
            token = page.get("NextContinuationToken")
            if not token or token in tokens:
                raise StorageError("R2 inventory cursor did not advance")
            tokens.add(token)

    async def _domain_settings(self, bucket):
        self._scope(bucket)
        root = (f"https://api.cloudflare.com/client/v4/accounts/{self.cfg.r2_account_id}"
                f"/r2/buckets/{quote(bucket, safe='')}/domains")
        try:
            # Both independent domain surfaces must be verified. One shared
            # deadline prevents sequential control-plane stalls from consuming
            # the ordinary save/download request's entire transport budget.
            async with asyncio.timeout(VISIBILITY_TIMEOUT_SECONDS):
                async with httpx.AsyncClient(timeout=VISIBILITY_TIMEOUT_SECONDS) as client:
                    async def check(suffix):
                        response = await client.get(root + "/" + suffix,
                            headers={"Authorization": f"Bearer {self.cfg.r2_api_token}"})
                        if response.status_code != 200:
                            raise StorageError("R2 bucket visibility check failed")
                        payload = response.json()
                        if (not isinstance(payload, dict) or payload.get("success") is not True
                                or not isinstance(payload.get("result"), dict)):
                            raise StorageError("Malformed R2 visibility response")
                        return payload["result"]
                    # Settle both tasks before the HTTP client closes, including
                    # failure/cancellation, without leaving an orphaned request.
                    jobs = [asyncio.create_task(check(suffix)) for suffix in ("managed", "custom")]
                    try:
                        return await asyncio.gather(*jobs)
                    finally:
                        for job in jobs:
                            if not job.done():
                                job.cancel()
                        await asyncio.gather(*jobs, return_exceptions=True)
        except (httpx.HTTPError, TimeoutError, ValueError, TypeError) as exc:
            # Provider URLs/headers/bodies may contain credentials. Expose only
            # the error class through our storage abstraction, never its text.
            raise StorageError(f"R2 bucket visibility unavailable ({type(exc).__name__})") from exc

    async def require_private_bucket(self, bucket):
        if bucket != self.cfg.supabase_private_bucket:
            raise StorageError("Not the configured private R2 bucket")
        # Only simultaneous callers share a fresh proof. No completed result or
        # stale success survives a provider outage or an external domain change.
        job = self._private_checks.get(bucket)
        if job is None or job.done():
            job = asyncio.create_task(self._verify_private_bucket(bucket))
            self._private_checks[bucket] = job
            def settled(task):
                if self._private_checks.get(bucket) is task:
                    self._private_checks.pop(bucket, None)
                if not task.cancelled():
                    task.exception()  # Observe failures even if all callers left.
            job.add_done_callback(settled)
        # A cancelled HTTP caller must not cancel another caller's fresh check.
        await asyncio.shield(job)

    async def _verify_private_bucket(self, bucket):
        managed, custom = await self._domain_settings(bucket)
        if (managed.get("enabled") is not False or not isinstance(custom.get("domains"), list)
                or any(not isinstance(row, dict) or row.get("enabled") is not False for row in custom["domains"])):
            raise StorageError("R2 private bucket has public or unverifiable domain access")

    async def ready(self):
        for bucket in (self.cfg.supabase_public_bucket, self.cfg.supabase_private_bucket):
            await self._call("head_bucket", Bucket=bucket)
        await self.require_private_bucket(self.cfg.supabase_private_bucket)
