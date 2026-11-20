"""Regression test: the floor-timed follow-up rule replaces the old
quotation_new/quotation_inactive pair. Ground Floor (Tiles) surfaces a
reminder 4 days after a quotation/selection is created; First Floor
(Sanitary) surfaces one after 7 days — see
docs/superpowers/specs/2026-07-27-followups-revamp-design.md."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from services.followup_engine import (
    quotation_followup_delay_days, quotation_followup_due_at, quotation_send_schedule,
)


def test_ground_floor_delay_is_four_days():
    assert quotation_followup_delay_days("ground-floor") == 4


def test_first_floor_delay_is_seven_days():
    assert quotation_followup_delay_days("first-floor") == 7


def test_unknown_floor_defaults_to_seven_days():
    assert quotation_followup_delay_days("second-floor") == 7


def test_not_due_yet_before_the_floor_window_elapses():
    created_at = datetime.now(timezone.utc) - timedelta(days=2)
    assert quotation_followup_due_at(created_at, "ground-floor") is None


def test_due_once_the_ground_floor_window_elapses():
    created_at = datetime.now(timezone.utc) - timedelta(days=5)
    due = quotation_followup_due_at(created_at, "ground-floor")
    assert due == created_at + timedelta(days=4)


def test_first_floor_not_due_at_four_days():
    created_at = datetime.now(timezone.utc) - timedelta(days=4)
    assert quotation_followup_due_at(created_at, "first-floor") is None


def test_first_floor_due_at_seven_days():
    created_at = datetime.now(timezone.utc) - timedelta(days=7)
    due = quotation_followup_due_at(created_at, "first-floor")
    assert due == created_at + timedelta(days=7)


def test_send_schedule_uses_india_calendar_day_across_utc_midnight_and_month_end():
    sent_at = datetime(2026, 11, 29, 19, 30, tzinfo=timezone.utc)
    assert quotation_send_schedule(sent_at, 3) == (date(2026, 12, 3), 3)
    assert quotation_send_schedule(sent_at, None) == (date(2026, 12, 7), 7)
    assert quotation_send_schedule(sent_at, None, date(2026, 12, 11)) == (date(2026, 12, 11), 11)
