"""Summary drilldowns keep floor boundaries while matching completed outcomes."""
from models import UserPublic
from routes import followup_routes


def matches(row, query):
    for key, value in query.items():
        if key == "$and":
            if not all(matches(row, term) for term in value): return False
        elif key == "$or":
            if not any(matches(row, term) for term in value): return False
        elif key == "$nor":
            if any(matches(row, term) for term in value): return False
        elif isinstance(value, dict):
            actual = row.get(key)
            if "$in" in value and actual not in value["$in"]: return False
            if "$nin" in value and actual in value["$nin"]: return False
            if "$ne" in value and actual == value["$ne"]: return False
            if "$gte" in value and (actual is None or actual < value["$gte"]): return False
            if "$lt" in value and (actual is None or actual >= value["$lt"]): return False
        elif row.get(key) != value: return False
    return True


def query(bucket=None, view="active", completed_today=False):
    user = UserPublic(id="member", email="sales@example.com", full_name="Sales", role="sales", floor_ids=["first-floor"], active_floor_id="first-floor")
    return followup_routes._paged_followup_query(user, bucket=bucket, priority=None, category=None, customer_tier=None, assigned_to=None, q=None, rule_type=None, view=view, waiting=False, completed_today=completed_today)


def test_active_and_won_views_keep_outcome_and_member_filters():
    base = {"floor_id": "first-floor", "status": "done", "category": "walk_in", "rule_type": "manual", "completed_outcome": "won", "auto_resolved": True, "assigned_to": "another-member"}
    assert not matches(base, query())
    assert not matches(base, query(view="won"))
    assert matches({**base, "assigned_to": "member"}, query(view="won"))


def test_expiring_matches_exact_open_rule_including_undated_rows():
    selected = query(bucket="expiring")
    base = {"floor_id": "first-floor", "status": "open", "rule_type": "quotation_expiring", "category": "quotation"}
    assert matches(base, selected)
    assert not matches({**base, "rule_type": "quotation_waiting"}, selected)
    assert not matches({**base, "status": "done"}, selected)
    assert not matches({**base, "status": "snoozed"}, selected)
    assert not matches({**base, "floor_id": "ground-floor"}, selected)
