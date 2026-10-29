"""Follow-ups 2.0 (Phase 1+2+3) — Tile Selections / Tile Quotations workspaces.

Covers (per review request):
  * GET /api/followups/config/automation-rules seeded defaults
    (selection [2,4,7,10], quotation_tiles [2,5,10,15]).
  * PUT /api/followups/config/automation-rules/{category} update + restore.
  * Workspace producer correctness: selection_waiting / quotation_tiles_waiting
    rows carry tag TILES and a reason starting with "Selection "/"Quotation ".
  * quotation_id on a workspace row resolves to the real matching Tiles doc.
  * WhatsApp contact template exact text for selection + quotation categories.
  * Auto-close: move-to-quotation resolves the open
    selection_waiting card (status=done, auto_resolved=true).
  * Regression: GET /followups/config/rules includes the two new rule types
    alongside all pre-existing ones, and a standard (non-tiles) quotation is
    never picked up by the tiles producer.
"""
import os

import pytest
import requests

BASE_URL = os.environ.get("TEST_BACKEND_URL", "").rstrip("/")
API = f"{BASE_URL}/api"
OWNER_EMAIL = os.environ.get("TEST_OWNER_EMAIL", "")
PASSWORD = os.environ.get("TEST_OWNER_PASSWORD", "")

pytestmark = pytest.mark.skipif(
    not (BASE_URL and OWNER_EMAIL and PASSWORD),
    reason="TEST_BACKEND_URL/TEST_OWNER_EMAIL/TEST_OWNER_PASSWORD not set",
)


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def owner_token(session):
    r = session.post(f"{API}/auth/login", json={"email": OWNER_EMAIL, "password": PASSWORD}, timeout=20)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def _h(tok):
    return {"Authorization": f"Bearer {tok}"}


class TestAutomationRulesConfig:
    def test_seeded_defaults(self, session, owner_token):
        r = session.get(f"{API}/followups/config/automation-rules", headers=_h(owner_token), timeout=15)
        assert r.status_code == 200, r.text
        rows = {row["category"]: row for row in r.json()}
        assert "selection" in rows and "quotation_tiles" in rows
        assert sorted(rows["selection"]["reminder_offsets_days"]) == [2, 4, 7, 10]
        assert sorted(rows["quotation_tiles"]["reminder_offsets_days"]) == [2, 5, 10, 15]

    def test_update_and_restore(self, session, owner_token):
        r = session.put(
            f"{API}/followups/config/automation-rules/selection",
            json={"reminder_offsets_days": [1, 3, 6, 9]},
            headers=_h(owner_token), timeout=15,
        )
        assert r.status_code == 200, r.text
        assert sorted(r.json()["reminder_offsets_days"]) == [1, 3, 6, 9]

        # verify persisted via a fresh GET
        r2 = session.get(f"{API}/followups/config/automation-rules", headers=_h(owner_token), timeout=15)
        rows = {row["category"]: row for row in r2.json()}
        assert sorted(rows["selection"]["reminder_offsets_days"]) == [1, 3, 6, 9]

        # restore default so other assertions/tests in this run aren't affected
        r3 = session.put(
            f"{API}/followups/config/automation-rules/selection",
            json={"reminder_offsets_days": [2, 4, 7, 10]},
            headers=_h(owner_token), timeout=15,
        )
        assert sorted(r3.json()["reminder_offsets_days"]) == [2, 4, 7, 10]


class TestRuleDefinitionsRegression:
    def test_config_rules_includes_new_and_old_types(self, session, owner_token):
        r = session.get(f"{API}/followups/config/rules", headers=_h(owner_token), timeout=15)
        assert r.status_code == 200
        rule_types = {row["rule_type"] for row in r.json()}
        for expected in (
            "selection_waiting", "quotation_tiles_waiting",  # new
            "quotation_followup", "quotation_expiring", "quotation_expired",  # pre-existing
            "payment_overdue", "payment_partial", "purchase_dispatched",
            "purchase_delivered", "customer_inactive", "shortage_reorder",
        ):
            assert expected in rule_types, f"Missing rule_type {expected}"


class TestWorkspaceProducer:
    @pytest.fixture(scope="class")
    def reconciled(self, session, owner_token):
        # reconcile scans the full quotations/purchase_orders collections and
        # is now serialized behind a process-local lock (race-condition fix) —
        # under concurrent load from other callers it can legitimately queue,
        # so a generous timeout avoids a false-failure test artifact here.
        r = session.post(f"{API}/followups/reconcile", headers=_h(owner_token), timeout=90)
        assert r.status_code == 200
        return r.json()

    @pytest.fixture(scope="class")
    def all_followups(self, session, owner_token, reconciled):
        r = session.get(f"{API}/followups?limit=3000", headers=_h(owner_token), timeout=20)
        assert r.status_code == 200
        return r.json()

    def test_stats_workspace_counts_present(self, session, owner_token, reconciled):
        r = session.get(f"{API}/followups/stats", headers=_h(owner_token), timeout=15)
        assert r.status_code == 200
        wc = r.json()["workspace_counts"]
        for key in ("selection", "quotation_tiles", "payment", "walk_in"):
            assert key in wc
            assert isinstance(wc[key], int)

    def test_selection_cards_shape(self, all_followups, session, owner_token):
        # Only OPEN cards — a done/auto_resolved card's underlying doc may
        # have legitimately changed doc_type since it was resolved (e.g. a
        # Selection that was later moved to a Quotation).
        sel = [f for f in all_followups if f["rule_type"] == "selection_waiting" and f["status"] == "open"]
        for f in sel:
            assert f["reason"].startswith("Selection "), f["reason"]
            assert "TILES" in f["tags"]
            assert f["category"] == "selection"
            # quotation_id must resolve to a REAL tiles_selection doc
            q = session.get(f"{API}/quotations/{f['quotation_id']}", headers=_h(owner_token), timeout=15).json()
            assert q["doc_type"] == "tiles_selection"

    def test_quotation_cards_shape(self, all_followups, session, owner_token):
        quo = [f for f in all_followups if f["rule_type"] == "quotation_tiles_waiting"]
        for f in quo:
            assert f["reason"].startswith("Quotation "), f["reason"]
            assert "TILES" in f["tags"]
            assert f["category"] == "quotation"
            q = session.get(f"{API}/quotations/{f['quotation_id']}", headers=_h(owner_token), timeout=15).json()
            assert q["doc_type"] == "tiles_quotation"

    def test_no_duplicate_source_keys_for_tiles_rules(self, all_followups):
        """Regression guard for the race-condition duplicate bug found live
        during this test pass (see RCA in test report) — reconcile_followups()
        must never leave two OPEN automated rows for the same source_key."""
        open_auto = [f for f in all_followups if f.get("is_automated") and f["status"] == "open"
                     and f["rule_type"] in ("selection_waiting", "quotation_tiles_waiting")]
        seen: dict[str, int] = {}
        for f in open_auto:
            k = f"{f['rule_type']}:{f['quotation_id']}"
            seen[k] = seen.get(k, 0) + 1
        dupes = {k: c for k, c in seen.items() if c > 1}
        assert not dupes, f"Duplicate OPEN automated cards for the same source_key: {dupes}"

    def test_standard_quotation_never_gets_tiles_rule_type(self, all_followups, session, owner_token):
        """A standard (non-tiles) quotation must never produce a
        selection_waiting/quotation_tiles_waiting card."""
        tiles_rows = [f for f in all_followups if f["rule_type"] in ("selection_waiting", "quotation_tiles_waiting")]
        for f in tiles_rows:
            q = session.get(f"{API}/quotations/{f['quotation_id']}", headers=_h(owner_token), timeout=15).json()
            assert q["doc_type"] in ("tiles_selection", "tiles_quotation"), (
                f"rule_type {f['rule_type']} fired for a standard quotation {f['quotation_id']}"
            )


class TestContactTemplates:
    @pytest.fixture(scope="class")
    def sel_and_quo_cards(self, session, owner_token):
        session.post(f"{API}/followups/reconcile", headers=_h(owner_token), timeout=90)
        rows = session.get(f"{API}/followups?limit=3000", headers=_h(owner_token), timeout=20).json()
        sel = next((f for f in rows if f["rule_type"] == "selection_waiting" and f["status"] == "open"), None)
        quo = next((f for f in rows if f["rule_type"] == "quotation_tiles_waiting" and f["status"] == "open"), None)
        return sel, quo

    def test_selection_whatsapp_template(self, session, owner_token, sel_and_quo_cards):
        sel, _ = sel_and_quo_cards
        if not sel:
            pytest.skip("No open selection_waiting card available to test")
        r = session.post(f"{API}/followups/{sel['id']}/contact", json={"channel": "whatsapp", "notes": "Sending the customer a follow-up message"}, headers=_h(owner_token), timeout=15)
        assert r.status_code == 200, r.text
        name = (sel["customer_name"] or "there").split()[0]
        expected = (
            f"Hello {name}, your tile selection has been completed. We'd be happy to prepare "
            "your quotation. Please let us know a convenient time to discuss it."
        )
        assert r.json()["message"] == expected

    def test_quotation_whatsapp_template_mentions_number(self, session, owner_token, sel_and_quo_cards):
        _, quo = sel_and_quo_cards
        if not quo:
            pytest.skip("No open quotation_tiles_waiting card available to test")
        r = session.post(f"{API}/followups/{quo['id']}/contact", json={"channel": "whatsapp", "notes": "Sending the customer a follow-up message"}, headers=_h(owner_token), timeout=15)
        assert r.status_code == 200, r.text
        msg = r.json()["message"]
        assert quo["quotation_number"] in msg
        assert msg.startswith(f"Hello {(quo['customer_name'] or 'there').split()[0]}")


class TestAutoCloseOnMoveToQuotation:
    def test_approve_and_move_resolves_selection_followup(self, session, owner_token):
        # Find any open tiles_selection with a matching open selection_waiting card.
        session.post(f"{API}/followups/reconcile", headers=_h(owner_token), timeout=90)
        rows = session.get(f"{API}/followups?limit=3000", headers=_h(owner_token), timeout=20).json()
        sel_cards = [f for f in rows if f["rule_type"] == "selection_waiting" and f["status"] == "open"]
        if not sel_cards:
            pytest.skip("No open selection_waiting card available for auto-close test")
        card = sel_cards[0]
        qid = card["quotation_id"]

        # Selection moves directly to quotation without a retired approval step.
        r2 = session.post(f"{API}/quotations/{qid}/move-to-quotation", headers=_h(owner_token), timeout=15)
        assert r2.status_code == 200, r2.text
        assert r2.json()["doc_type"] == "tiles_quotation"

        r3 = session.post(f"{API}/followups/reconcile", headers=_h(owner_token), timeout=90)
        assert r3.status_code == 200

        r4 = session.get(f"{API}/followups/{card['id']}", headers=_h(owner_token), timeout=15)
        assert r4.status_code == 200
        f = r4.json()["followup"]
        assert f["status"] == "done"
        assert f["auto_resolved"] is True
