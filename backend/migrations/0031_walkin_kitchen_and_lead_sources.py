"""Rename the display label and remove two verified test-only source choices.

Walk-in source history and stable floor IDs remain untouched.
"""
TEST_SOURCES = ["TEST Source 1785460004", "TEST_SRC_1785460004"]


async def up(db):
    await db.floors.update_one({"id": "second-floor"}, {"$set": {"name": "Kitchen Floor"}})
    await db.settings.update_one({"key": "lead_sources"}, {"$pull": {"sources": {"$in": TEST_SOURCES}}})
