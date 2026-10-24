"""Cloudflare R2 through its S3 API; blocking SDK calls run off the event loop.

Bucket names remain the existing logical names so stored Mongo references and
private backup receipts remain valid. Only the public bucket has a public URL.
"""
from __future__ import annotations

import asyncio
import hashlib
from urllib.parse import quote

import boto3
import httpx
from botocore.config import Config
from botocore.exceptions import ClientError

from settings import settings
from .base import MediaStorage, StoredObject, StorageError


class R2StorageDriver(MediaStorage):
    def __init__(self, *, cfg=None, client=None):
        self.cfg = cfg or settings
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
        return StoredObject(bucket=bucket, key=key,
                            public_url=self.get_public_url(bucket=bucket, key=key) if public else None,
                            size_bytes=len(data), content_type=content_type,
                            sha1=hashlib.sha1(data).hexdigest())

    async def replace(self, *, bucket, key, data, content_type):
        return await self.upload(bucket=bucket, key=key, data=data, content_type=content_type)

    async def delete(self, *, bucket, key):
        self._scope(bucket, key)
        await self._call("delete_object", Bucket=bucket, Key=key)

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
        result = []
        async with httpx.AsyncClient(timeout=10) as client:
            for suffix in ("managed", "custom"):
                response = await client.get(root + "/" + suffix,
                    headers={"Authorization": f"Bearer {self.cfg.r2_api_token}"})
                if response.status_code != 200:
                    raise StorageError("R2 bucket visibility check failed")
                payload = response.json()
                if payload.get("success") is not True or not isinstance(payload.get("result"), dict):
                    raise StorageError("Malformed R2 visibility response")
                result.append(payload["result"])
        return result

    async def require_private_bucket(self, bucket):
        if bucket != self.cfg.supabase_private_bucket:
            raise StorageError("Not the configured private R2 bucket")
        managed, custom = await self._domain_settings(bucket)
        if (managed.get("enabled") is not False or not isinstance(custom.get("domains"), list)
                or any(row.get("enabled") is not False for row in custom["domains"])):
            raise StorageError("R2 private bucket has public or unverifiable domain access")

    async def ready(self):
        for bucket in (self.cfg.supabase_public_bucket, self.cfg.supabase_private_bucket):
            await self._call("head_bucket", Bucket=bucket)
        await self.require_private_bucket(self.cfg.supabase_private_bucket)
