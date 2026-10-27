"""Read deadlines fail explicitly; optional caches cannot hide DB failures."""
import pytest
from fastapi import HTTPException
from pymongo.errors import ExecutionTimeout

from services.kitchen_projects import bounded_read


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [ExecutionTimeout("query deadline"), TimeoutError("transport deadline")])
async def test_slow_kitchen_reads_return_retryable_service_error(failure):
    with pytest.raises(HTTPException) as caught:
        async with bounded_read():
            raise failure
    assert caught.value.status_code == 503
    assert "retry" in caught.value.detail


@pytest.mark.asyncio
async def test_cancellation_is_not_converted_into_backend_failure():
    import asyncio
    with pytest.raises(asyncio.CancelledError):
        async with bounded_read():
            raise asyncio.CancelledError()
