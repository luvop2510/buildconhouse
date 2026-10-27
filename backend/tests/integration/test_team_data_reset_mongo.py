"""Opt-in reset transactions on a disposable local replica-set database only."""
from __future__ import annotations

import asyncio
import importlib
import os

import pytest
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import DuplicateKeyError

from auth import verify_password
from services.team_credentials import decrypt_password
from services.team_data_reset import (
    OWNER_ID, OWNER_LOGIN, RECEIPT_ID, REQUEST_ID, reset_team_data, team_reset_preview,
)

TEST_PASSWORD = "disposable-test-owner-pass"


@pytest.fixture
def disposable_url():
    url = os.environ.get("TEAM_RESET_TEST_MONGO_URL", "")
    if not url:
        pytest.skip("Set TEAM_RESET_TEST_MONGO_URL to a local disposable replica set")
    if not url.startswith(("mongodb://127.0.0.1:", "mongodb://localhost:")):
        raise RuntimeError("Reset tests require a local disposable MongoDB")
    return url


async def seed(database):
    await database.users.insert_many([
        {"id": "old-owner", "email": "old@example.com", "role": "owner", "password_hash": "old", "mfa_secret_encrypted": "old"},
        {"id": "old-staff", "email": "staff@example.com", "role": "sales"},
    ])
    await database.customers.insert_many([
        {"id": "customer", "name": "Keep customer", "portal_enabled": True, "password_hash": "old-customer",
            "must_change_password": True, "temp_password_expires_at": "old", "google_sub": "old-sub"},
        {"id": "business-only", "name": "Keep another customer", "portal_enabled": False,
            "must_change_password": False, "password_hash": None, "temp_password_expires_at": None},
    ])
    await database.user_sessions.insert_many([
        {"id": "staff-session", "user_type": "staff", "user_id": "old-owner"},
        {"id": "customer-session", "user_type": "customer", "user_id": "customer"},
    ])
    await database.access_grants.insert_one({"id": "old-grant", "user_id": "old-staff"})
    await database.download_tokens.insert_one({"token": "old-download", "kind": "customer"})
    await database.product_usage.insert_one({"user_id": "old-staff", "product_id": "product"})
    await database.followup_saved_views.insert_one({"id": "saved", "user_id": "old-staff"})
    await database.notifications.insert_many([
        {"id": "personal", "user_id": "old-owner"}, {"id": "business", "floor_id": "ground-floor"},
    ])
    await database.activity_events.insert_many([
        {"id": "login", "event_type": "user.login", "entity_type": "user"},
        {"id": "business", "event_type": "purchase.created", "actor_id": "old-owner"},
    ])
    await database.settings.insert_many([
        {"key": "permission_matrix", "overrides": {"sales": {"catalog": False}}},
        {"key": "company", "name": "Keep company"},
    ])
    for name in ("products", "godown_stock", "quotations", "payments", "purchase_orders"):
        await database[name].insert_one({"id": name, "quantity": 4, "actor_id": "old-owner"})


def test_reset_atomic_preview_preservation_replay_and_username_index(disposable_url, monkeypatch):
    monkeypatch.setenv("FORGE_CUSTOMER_RESET_MAINTENANCE", "true")

    async def run():
        client = AsyncIOMotorClient(disposable_url)
        database = client.forge_team_reset_test
        try:
            await client.drop_database(database.name)
            await seed(database)
            preview = await team_reset_preview(database)
            assert preview["deleted"]["users"] == 2
            assert preview["deleted"]["user_sessions"] == 2
            assert preview["portal_accounts_disabled"] == 1
            assert await database.users.count_documents({}) == 2
            await importlib.import_module("migrations.0030_staff_login_id_index").up(database)
            receipt = await reset_team_data(database, client, request_id=REQUEST_ID,
                owner_password=TEST_PASSWORD, expected_user_count=2)
            owner = await database.users.find_one({"id": OWNER_ID})
            assert await database.users.count_documents({}) == 1
            assert owner["login_id"] == owner["full_name"] == OWNER_LOGIN
            assert owner["role"] == "owner" and verify_password(TEST_PASSWORD, owner["password_hash"])
            assert decrypt_password(owner["password_encrypted"], OWNER_ID) == TEST_PASSWORD
            assert TEST_PASSWORD not in str(receipt) and TEST_PASSWORD not in str(owner)
            assert receipt["portal_accounts_disabled"] == 1
            assert receipt["customer_credential_rows_scrubbed"] == 2
            customer = await database.customers.find_one({"id": "customer"})
            assert customer["name"] == "Keep customer" and customer["portal_enabled"] is False
            assert not {"password_hash", "google_sub", "must_change_password", "temp_password_expires_at"} & customer.keys()
            assert await database.customers.count_documents({}) == 2
            for name in ("user_sessions", "access_grants", "download_tokens", "followup_saved_views", "product_usage"):
                assert await database[name].count_documents({}) == 0
            for name in ("products", "godown_stock", "quotations", "payments", "purchase_orders"):
                assert (await database[name].find_one({}))["quantity"] == 4
            assert await database.notifications.count_documents({}) == 1
            assert await database.activity_events.count_documents({"id": "business"}) == 1
            assert await database.settings.find_one({"key": "company"})
            assert not await database.settings.find_one({"key": "permission_matrix"})
            await database.users.insert_one({"id": "new-staff", "email": "new@example.com"})
            replay = await reset_team_data(database, client, request_id=REQUEST_ID,
                owner_password="different-test-password", expected_user_count=999)
            assert replay["already_applied"] and await database.users.count_documents({}) == 2
            assert verify_password(TEST_PASSWORD, (await database.users.find_one({"id": OWNER_ID}))["password_hash"])
            with pytest.raises(DuplicateKeyError):
                await database.users.insert_one({"id": "duplicate", "login_id_key": "jk patel"})
        finally:
            await client.drop_database(database.name)
            client.close()

    asyncio.run(run())


def test_transaction_rolls_back_after_deletes_if_owner_insert_fails(disposable_url, monkeypatch):
    monkeypatch.setenv("FORGE_CUSTOMER_RESET_MAINTENANCE", "true")

    async def run():
        client = AsyncIOMotorClient(disposable_url)
        database = client.forge_team_reset_test
        try:
            await client.drop_database(database.name)
            await seed(database)
            # A server-side validator creates an actual insert failure after
            # all deletes/credential updates, rather than a fake transaction.
            await database.command({"collMod": "users", "validator": {"id": {"$ne": OWNER_ID}}, "validationLevel": "strict"})
            from pymongo.errors import OperationFailure
            with pytest.raises(OperationFailure):
                await reset_team_data(database, client, request_id=REQUEST_ID,
                    owner_password=TEST_PASSWORD, expected_user_count=2)
            assert await database.users.count_documents({}) == 2
            assert await database.user_sessions.count_documents({}) == 2
            assert await database.access_grants.count_documents({}) == 1
            assert (await database.customers.find_one({"id": "customer"}))["portal_enabled"] is True
            assert not await database.settings.find_one({"_id": RECEIPT_ID})
        finally:
            await client.drop_database(database.name)
            client.close()

    asyncio.run(run())


def test_stale_preview_aborts_without_changes(disposable_url, monkeypatch):
    monkeypatch.setenv("FORGE_CUSTOMER_RESET_MAINTENANCE", "true")

    async def run():
        client = AsyncIOMotorClient(disposable_url)
        database = client.forge_team_reset_test
        try:
            await client.drop_database(database.name)
            await seed(database)
            with pytest.raises(RuntimeError, match="Staff count changed"):
                await reset_team_data(database, client, request_id=REQUEST_ID,
                    owner_password=TEST_PASSWORD, expected_user_count=1)
            assert await database.users.count_documents({}) == 2
            assert await database.user_sessions.count_documents({}) == 2
        finally:
            await client.drop_database(database.name)
            client.close()

    asyncio.run(run())
