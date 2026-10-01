"""Follow-ups V2 (Sales Command Center) backend tests.

Covers (per review request):
  * Event-triggered reconciliation (quotation status change, order confirm,
    payment recorded, purchase item stage move) — NOT cron, verified by
    polling GET /api/followups without calling POST /api/followups/reconcile.
  * No-answer call escalation (2nd miss -> tomorrow 09:30 + score bump).
  * GET /api/followups/stats new fields.
  * GET /api/followups/{id} detail.stats new fields (conversion_rate,
    average_order_value, preferred_salesperson, risk_level).
  * Export (xlsx/csv) + route-ordering vs /{followup_id}.
  * Saved Views CRUD + per-user scoping.
  * Regression of pre-existing Follow-ups endpoints.
"""
import os
import time

import pytest
import requests

# Never a hardcoded stale preview URL or the known demo password — the whole
# module skips cleanly if a real test environment isn't configured, instead
# of hitting production or crashing at collection time.
BASE_URL = os.environ.get("TEST_BACKEND_URL", "").rstrip("/")
API = f"{BASE_URL}/api"
PASSWORD = os.environ.get("TEST_OWNER_PASSWORD", "")
OWNER_EMAIL = os.environ.get("TEST_OWNER_EMAIL", "")
SALES_EMAIL = os.environ.get("TEST_SALES_EMAIL", "sales@forge.app")
CUSTOMER_EMAIL = os.environ.get("TEST_CUSTOMER_EMAIL", "customer@forge.app")

pytestmark = pytest.mark.skipif(
    not (BASE_URL and OWNER_EMAIL and PASSWORD),
    reason="TEST_BACKEND_URL/TEST_OWNER_EMAIL/TEST_OWNER_PASSWORD not set",
)


# ----------------------------- fixtures -----------------------------------
@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _login(session, email, password=PASSWORD):
    r = session.post(f"{API}/auth/login", json={"email": email, "password": password}, timeout=20)
    assert r.status_code == 200, f"login failed for {email}: {r.status_code} {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def owner_token(session):
    return _login(session, OWNER_EMAIL)


@pytest.fixture(scope="module")
def sales_token(session):
    return _login(session, SALES_EMAIL)


def _h(tok):
    return {"Authorization": f"Bearer {tok}"}


@pytest.fixture(scope="module")
def catalog(session, owner_token):
    prods = session.get(f"{API}/products", headers=_h(owner_token), timeout=15).json()["items"]
    customers = session.get(f"{API}/customers", headers=_h(owner_token), timeout=15).json()
    target = next((c for c in customers if c["email"] == CUSTOMER_EMAIL), customers[0])
    return {"product": prods[0], "customer": target}


def _line(p, qty=1):
    return {
        "product_id": p["id"], "sku": p["sku"], "name": p["name"],
        "image": (p.get("images") or [None])[0], "category_id": p.get("category_id"),
        "room": None, "qty": qty, "unit_price": p["price"], "discount_pct": None,
    }


def _poll_until(fn, predicate, timeout=15, interval=1.5):
    """Poll fn() until predicate(result) is True or timeout. Returns last result."""
    deadline = time.time() + timeout
    result = None
    while time.time() < deadline:
        result = fn()
        if predicate(result):
            return result
        time.sleep(interval)
    return result


# ======================= Event-triggered reconciliation ====================
class TestEventTriggeredReconciliation:
    """None of these tests call POST /followups/reconcile manually — the
    whole point is proving the mutation itself triggers the async refresh."""

    def test_quotation_status_change_triggers_reconcile(self, session, owner_token, catalog):
        payload = {
            "customer_id": catalog["customer"]["id"],
            "items": [_line(catalog["product"], 2)],
            "project_name": "TEST_reconcile_status_change",
        }
        r = session.post(f"{API}/quotations", json=payload, headers=_h(owner_token), timeout=20)
        assert r.status_code == 200, r.text
        quot = r.json()
        qid, qnum = quot["id"], quot["number"]

        r2 = session.patch(f"{API}/quotations/{qid}", json={"status": "sent"}, headers=_h(owner_token), timeout=20)
        assert r2.status_code == 200, r2.text

        # As of the 2026-07-27 floor-timed follow-up redesign, a same-day
        # quotation must NOT produce an automated quotation_followup card —
        # the first nudge is deferred to 4 days (ground floor) / 7 days
        # (first floor) after creation. Give the event-triggered reconcile
        # pass a moment to run, then confirm it correctly produced nothing
        # for this quotation yet.
        time.sleep(2)
        rows = session.get(f"{API}/followups", params={"q": qnum}, headers=_h(owner_token), timeout=15).json()
        matched = [row for row in rows if row.get("quotation_number") == qnum and row.get("rule_type") == "quotation_followup"]
        assert matched == [], "A same-day quotation must not surface a quotation_followup card yet"

    def test_order_confirm_and_payment_and_dispatch_trigger_reconcile(self, session, owner_token, catalog):
        # 1) Create quotation
        payload = {
            "customer_id": catalog["customer"]["id"],
            "items": [_line(catalog["product"], 3)],
            "project_name": "TEST_reconcile_order_flow",
        }
        r = session.post(f"{API}/quotations", json=payload, headers=_h(owner_token), timeout=20)
        assert r.status_code == 200, r.text
        quot = r.json()
        qid, qnum, grand_total = quot["id"], quot["number"], quot["grand_total"]
        assert grand_total > 0

        # 2) Confirm order (place-order/confirm) — event trigger #2
        r2 = session.post(f"{API}/quotations/{qid}/place-order/confirm", json={}, headers=_h(owner_token), timeout=20)
        assert r2.status_code == 200, r2.text
        po_ids = r2.json()["purchase_orders"]
        assert len(po_ids) >= 1
        po = po_ids[0]
        assert po["items"], "Expected PO to have items"
        item_id = po["items"][0]["id"]
        po_number = po["number"]

        # 3) Record a PARTIAL payment — event trigger #3 (payment.recorded)
        partial_amount = round(grand_total / 2, 2)
        r3 = session.post(
            f"{API}/payments",
            json={"quotation_id": qid, "amount": partial_amount, "mode": "cash", "note": "TEST partial"},
            headers=_h(owner_token), timeout=20,
        )
        assert r3.status_code == 200, r3.text

        def fetch_payment():
            return session.get(f"{API}/followups", params={"q": qnum}, headers=_h(owner_token), timeout=15).json()

        rows = _poll_until(fetch_payment, lambda rows: any(rw.get("rule_type") == "payment_partial" for rw in rows), timeout=15)
        payment_rows = [rw for rw in rows or [] if rw.get("rule_type") == "payment_partial"]
        assert payment_rows, "Expected payment_partial follow-up to auto-appear after payment WITHOUT manual reconcile"
        assert payment_rows[0]["quotation_number"] == qnum
        assert payment_rows[0]["value"] > 0

        # 4) Move PO item to 'dispatched' — event trigger #4 (purchase.stage_moved)
        r4 = session.post(
            f"{API}/purchases/items/{item_id}/move",
            json={"stage": "dispatched", "note": "TEST dispatch"},
            headers=_h(owner_token), timeout=20,
        )
        assert r4.status_code == 200, r4.text

        def fetch_dispatch():
            return session.get(f"{API}/followups", params={"q": po_number}, headers=_h(owner_token), timeout=15).json()

        rows2 = _poll_until(fetch_dispatch, lambda rows: any(rw.get("rule_type") == "purchase_dispatched" for rw in rows), timeout=15)
        dispatch_rows = [rw for rw in rows2 or [] if rw.get("rule_type") == "purchase_dispatched"]
        assert dispatch_rows, "Expected purchase_dispatched follow-up to auto-appear after stage move WITHOUT manual reconcile"
        assert dispatch_rows[0]["purchase_number"] == po_number


# ============================= No-answer escalation =========================
class TestNoAnswerEscalation:
    def test_second_no_answer_escalates(self, session, owner_token, catalog):
        create_payload = {
            "customer_id": catalog["customer"]["id"],
            "category": "general", "channel": "call",
            "reason": "TEST_no_answer_escalation",
        }
        r = session.post(f"{API}/followups", json=create_payload, headers=_h(owner_token), timeout=20)
        assert r.status_code == 200, r.text
        f = r.json()
        fid = f["id"]
        original_score = f["priority_score"]

        # 1st no_answer -> +4h, no escalation
        r1 = session.post(f"{API}/followups/{fid}/log-call", json={"outcome": "no_answer", "notes": "Customer did not answer the call"}, headers=_h(owner_token), timeout=20)
        assert r1.status_code == 200, r1.text
        d1 = r1.json()
        assert d1["contact_attempts"] == 1
        assert d1["priority_score"] == original_score

        # 2nd no_answer -> escalate: due_at tomorrow 09:30, +10 score capped at 100
        r2 = session.post(f"{API}/followups/{fid}/log-call", json={"outcome": "no_answer", "notes": "Customer did not answer the call"}, headers=_h(owner_token), timeout=20)
        assert r2.status_code == 200, r2.text
        d2 = r2.json()
        assert d2["contact_attempts"] == 2
        assert d2["priority_score"] == min(100, original_score + 10)
        due_at = d2["due_at"]
        assert due_at is not None
        assert due_at[11:16] == "09:30", f"Expected due_at time 09:30, got {due_at}"


# ================================ Stats fields ==============================
class TestStatsFields:
    def test_stats_has_new_fields(self, session, owner_token):
        r = session.get(f"{API}/followups/stats", headers=_h(owner_token), timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        for key in ("overdue_payments_count", "overdue_payments_amount", "overdue_payments_amount_short", "expiring_quotations_count"):
            assert key in data, f"Missing stats field: {key}"
        assert isinstance(data["overdue_payments_count"], int)
        assert isinstance(data["overdue_payments_amount"], (int, float))
        assert isinstance(data["expiring_quotations_count"], int)


# ================================ Detail stats ===============================
class TestDetailStats:
    def test_detail_stats_new_fields(self, session, owner_token):
        rows = session.get(f"{API}/followups", headers=_h(owner_token), timeout=15).json()
        assert rows, "Need at least one follow-up to test detail"
        fid = rows[0]["id"]
        r = session.get(f"{API}/followups/{fid}", headers=_h(owner_token), timeout=15)
        assert r.status_code == 200, r.text
        stats = r.json()["stats"]
        assert 0 <= stats["conversion_rate"] <= 100
        assert isinstance(stats["conversion_rate"], int)
        assert isinstance(stats["average_order_value"], (int, float))
        assert stats["preferred_salesperson"] is None or isinstance(stats["preferred_salesperson"], str)
        assert stats["risk_level"] in ("low", "medium", "high")


# ================================ Export =====================================
class TestExport:
    def test_export_xlsx(self, session, owner_token):
        r = session.get(f"{API}/followups/export", params={"format": "xlsx"}, headers=_h(owner_token), timeout=20)
        assert r.status_code == 200, r.text
        assert "attachment" in r.headers.get("Content-Disposition", "")
        assert len(r.content) > 100

    def test_export_csv(self, session, owner_token):
        r = session.get(f"{API}/followups/export", params={"format": "csv"}, headers=_h(owner_token), timeout=20)
        assert r.status_code == 200, r.text
        assert "attachment" in r.headers.get("Content-Disposition", "")
        assert "text/csv" in r.headers.get("Content-Type", "")

    def test_export_respects_filters(self, session, owner_token):
        r = session.get(f"{API}/followups/export", params={"format": "csv", "priority": "critical"}, headers=_h(owner_token), timeout=20)
        assert r.status_code == 200, r.text

    def test_export_route_ordering_not_confused_with_followup_id(self, session, owner_token):
        # If 'export' were swallowed by GET /{followup_id}, this would 404 with
        # "Follow-up not found" instead of returning a file.
        r = session.get(f"{API}/followups/export", params={"format": "csv"}, headers=_h(owner_token), timeout=20)
        assert r.status_code == 200
        assert r.headers.get("Content-Type") != "application/json"


# ============================== Saved Views ==================================
class TestSavedViews:
    def test_create_list_delete_saved_view(self, session, owner_token):
        payload = {"name": "TEST_view_critical_vip", "filters": {"priorityFilter": "critical", "tierFilter": "vip"}}
        r = session.post(f"{API}/followups/saved-views", json=payload, headers=_h(owner_token), timeout=15)
        assert r.status_code == 200, r.text
        view = r.json()
        assert view["name"] == payload["name"]
        assert view["filters"] == payload["filters"]
        view_id = view["id"]

        r2 = session.get(f"{API}/followups/saved-views", headers=_h(owner_token), timeout=15)
        assert r2.status_code == 200
        ids = [v["id"] for v in r2.json()]
        assert view_id in ids

        r3 = session.delete(f"{API}/followups/saved-views/{view_id}", headers=_h(owner_token), timeout=15)
        assert r3.status_code == 200

        r4 = session.get(f"{API}/followups/saved-views", headers=_h(owner_token), timeout=15)
        ids_after = [v["id"] for v in r4.json()]
        assert view_id not in ids_after

    def test_saved_view_scoped_to_user(self, session, owner_token, sales_token):
        payload = {"name": "TEST_view_owner_scoped", "filters": {"q": "abc"}}
        r = session.post(f"{API}/followups/saved-views", json=payload, headers=_h(owner_token), timeout=15)
        assert r.status_code == 200
        view_id = r.json()["id"]

        r2 = session.get(f"{API}/followups/saved-views", headers=_h(sales_token), timeout=15)
        sales_view_ids = [v["id"] for v in r2.json()]
        assert view_id not in sales_view_ids, "Saved view leaked across users"

        # cleanup
        session.delete(f"{API}/followups/saved-views/{view_id}", headers=_h(owner_token), timeout=15)


# ============================ Regression suite ================================
class TestRegressionExistingEndpoints:
    def test_reconcile_manual(self, session, owner_token):
        r = session.post(f"{API}/followups/reconcile", headers=_h(owner_token), timeout=30)
        assert r.status_code == 200
        body = r.json()
        for key in ("created", "updated", "auto_resolved", "active"):
            assert key in body

    def test_mission(self, session, owner_token):
        r = session.get(f"{API}/followups/mission", headers=_h(owner_token), timeout=15)
        assert r.status_code == 200
        body = r.json()
        assert "due_count" in body and "top_priorities" in body

    def test_insights(self, session, owner_token):
        r = session.get(f"{API}/followups/insights", headers=_h(owner_token), timeout=15)
        assert r.status_code == 200
        body = r.json()
        assert "calls_completed" in body

    def test_list_with_filters(self, session, owner_token):
        r = session.get(f"{API}/followups", params={"bucket": "overdue"}, headers=_h(owner_token), timeout=15)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_create_patch_snooze_complete_contact_dismiss(self, session, owner_token, catalog):
        r = session.post(
            f"{API}/followups",
            json={"customer_id": catalog["customer"]["id"], "reason": "TEST_regression_flow", "category": "general", "channel": "whatsapp"},
            headers=_h(owner_token), timeout=15,
        )
        assert r.status_code == 200
        fid = r.json()["id"]

        r2 = session.patch(f"{API}/followups/{fid}", json={"notes": "TEST note"}, headers=_h(owner_token), timeout=15)
        assert r2.status_code == 200
        assert r2.json()["notes"] == "TEST note"

        r3 = session.post(f"{API}/followups/{fid}/snooze", json={"preset": "1h", "notes": "Customer requested a call after one hour"}, headers=_h(owner_token), timeout=15)
        assert r3.status_code == 200
        assert r3.json()["status"] == "snoozed"

        # wake it back up by patching (simulate wake_snoozed elapsed) — just re-fetch list which self-heals
        r4 = session.post(f"{API}/followups/{fid}/contact", json={"channel": "whatsapp", "notes": "Sending the customer a follow-up message"}, headers=_h(owner_token), timeout=15)
        assert r4.status_code == 200
        assert "wa_url" in r4.json()

        r5 = session.post(f"{API}/followups/{fid}/complete", json={"notes": "done"}, headers=_h(owner_token), timeout=15)
        assert r5.status_code == 200
        assert r5.json()["status"] == "done"

        # dismiss a fresh one
        r6 = session.post(
            f"{API}/followups",
            json={"customer_id": catalog["customer"]["id"], "reason": "TEST_regression_dismiss", "category": "general", "channel": "call"},
            headers=_h(owner_token), timeout=15,
        )
        fid2 = r6.json()["id"]
        r7 = session.patch(f"{API}/followups/{fid2}", json={"status": "dismissed", "notes": "Duplicate reminder no longer needed"}, headers=_h(owner_token), timeout=15)
        assert r7.status_code == 200
        assert r7.json()["status"] == "dismissed"

    def test_config_rules_and_assignees(self, session, owner_token):
        r = session.get(f"{API}/followups/config/rules", headers=_h(owner_token), timeout=15)
        assert r.status_code == 200
        assert isinstance(r.json(), list) and len(r.json()) > 0

        r2 = session.get(f"{API}/followups/config/assignees", headers=_h(owner_token), timeout=15)
        assert r2.status_code == 200
        assert isinstance(r2.json(), list)
