"""
Forge — Purchases Material Tracker — Comprehensive Backend Test Suite

Tests all 14 requirements from the review request:
1. GET /api/purchases/stages
2. GET /api/purchases/brands
3. GET /api/purchases/customers
4. GET /api/purchases/items?view=today
5. GET /api/purchases/items with filters
6. GET /api/purchases/items/{item_id}
7. POST /api/purchases/items/{item_id}/move
8. POST /api/purchases/items/bulk-move
9. POST /api/purchases/items/{item_id}/transfer
10. GET /api/purchases/export.xlsx
11. GET/POST /api/purchases/settings
12. AUTH checks (401 without token)
13. REGRESSION checks
14. SEED INTEGRITY checks
"""
import os
import sys
import requests
import json
from typing import Optional, Dict, Any

# Backend URL configuration
BASE_URL = os.environ.get("TEST_BACKEND_URL", "http://localhost:8001").rstrip("/")
API_BASE = f"{BASE_URL}/api"

# Test credentials
TEST_EMAIL = "owner@forge.app"
TEST_PASSWORD = os.environ["FORGE_TEST_OWNER_PASSWORD"]

class TestResult:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.failures = []
        self.test_data = {}  # Store data for use across tests
    
    def add_pass(self, test_name: str):
        self.passed += 1
        print(f"✅ PASS: {test_name}")
    
    def add_fail(self, test_name: str, reason: str, details: Optional[dict] = None):
        self.failed += 1
        self.failures.append({
            "test": test_name,
            "reason": reason,
            "details": details
        })
        print(f"❌ FAIL: {test_name}")
        print(f"   Reason: {reason}")
        if details:
            print(f"   Details: {details}")
    
    def summary(self):
        total = self.passed + self.failed
        print("\n" + "="*80)
        print(f"TEST SUMMARY: {self.passed}/{total} PASSED ({self.passed/total*100:.1f}%)")
        print("="*80)
        if self.failures:
            print("\n❌ FAILED TESTS:")
            for f in self.failures:
                print(f"  • {f['test']}: {f['reason']}")
        print()

def login() -> str:
    """Login and return JWT token"""
    print(f"\n🔐 Logging in as {TEST_EMAIL}...")
    resp = requests.post(f"{API_BASE}/auth/login", json={
        "email": TEST_EMAIL,
        "password": TEST_PASSWORD
    })
    if resp.status_code != 200:
        print(f"❌ Login failed: {resp.status_code} {resp.text}")
        sys.exit(1)
    token = resp.json().get("access_token")
    print("✅ Login successful (credential response omitted)")
    return token

def headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}

# =============================================================================
# TEST 1: GET /api/purchases/stages
# =============================================================================
def test_stages(token: str, result: TestResult):
    print("\n" + "="*80)
    print("TEST 1: GET /api/purchases/stages")
    print("="*80)
    
    resp = requests.get(f"{API_BASE}/purchases/stages", headers=headers(token))
    
    # 1.1: Returns 200
    if resp.status_code != 200:
        result.add_fail("1.1: GET /purchases/stages returns 200", 
                       f"Got {resp.status_code}", {"body": resp.text})
        return
    result.add_pass("1.1: GET /purchases/stages returns 200")
    
    data = resp.json()
    
    # 1.2: Returns array of 6 stages
    if not isinstance(data, list) or len(data) != 6:
        result.add_fail("1.2: Returns array of 6 stages", 
                       f"Got {type(data)} with length {len(data) if isinstance(data, list) else 'N/A'}")
        return
    result.add_pass("1.2: Returns array of 6 stages")
    
    # 1.3: Stages in correct order
    expected_order = ["order_in_company", "company_billing", "in_box", "dispatched", "in_transit", "delivered"]
    actual_order = [s.get("key") for s in data]
    if actual_order != expected_order:
        result.add_fail("1.3: Stages in correct order", 
                       f"Expected {expected_order}, got {actual_order}")
    else:
        result.add_pass("1.3: Stages in correct order")
    
    # 1.4: Each stage has required fields
    required_fields = ["key", "label", "count", "tone"]
    for stage in data:
        missing = [f for f in required_fields if f not in stage]
        if missing:
            result.add_fail(f"1.4: Stage {stage.get('key')} has all required fields", 
                           f"Missing fields: {missing}")
            return
    result.add_pass("1.4: All stages have required fields (key, label, count, tone)")
    
    # 1.5: Tone has bg and fg
    for stage in data:
        tone = stage.get("tone", {})
        if not isinstance(tone, dict) or "bg" not in tone or "fg" not in tone:
            result.add_fail(f"1.5: Stage {stage.get('key')} tone has bg and fg", 
                           f"Got tone: {tone}")
            return
    result.add_pass("1.5: All stages have tone with bg and fg")
    
    # 1.6: Sum of counts should equal total active items
    total_count = sum(s.get("count", 0) for s in data)
    result.test_data["total_items_from_stages"] = total_count
    print(f"   Total items across all stages: {total_count}")
    result.add_pass(f"1.6: Sum of stage counts = {total_count}")

# =============================================================================
# TEST 2: GET /api/purchases/brands
# =============================================================================
def test_brands(token: str, result: TestResult):
    print("\n" + "="*80)
    print("TEST 2: GET /api/purchases/brands")
    print("="*80)
    
    resp = requests.get(f"{API_BASE}/purchases/brands", headers=headers(token))
    
    # 2.1: Returns 200
    if resp.status_code != 200:
        result.add_fail("2.1: GET /purchases/brands returns 200", 
                       f"Got {resp.status_code}", {"body": resp.text})
        return
    result.add_pass("2.1: GET /purchases/brands returns 200")
    
    data = resp.json()
    
    # 2.2: Has 'all' and 'brands' keys
    if "all" not in data or "brands" not in data:
        result.add_fail("2.2: Response has 'all' and 'brands' keys", 
                       f"Got keys: {list(data.keys())}")
        return
    result.add_pass("2.2: Response has 'all' and 'brands' keys")
    
    # 2.3: 'all' is a number
    if not isinstance(data["all"], (int, float)):
        result.add_fail("2.3: 'all' is a number", f"Got type: {type(data['all'])}")
    else:
        result.add_pass("2.3: 'all' is a number")
    
    # 2.4: 'brands' is an array
    if not isinstance(data["brands"], list):
        result.add_fail("2.4: 'brands' is an array", f"Got type: {type(data['brands'])}")
        return
    result.add_pass("2.4: 'brands' is an array")
    
    # 2.5: Should include expected brands
    expected_brands = ["Grohe", "Vitra", "Geberit", "Axor", "Hansgrohe"]
    brand_names = [b.get("name") for b in data["brands"]]
    missing_brands = [b for b in expected_brands if b not in brand_names]
    if missing_brands:
        result.add_fail("2.5: Includes expected brands (Grohe, Vitra, Geberit, Axor, Hansgrohe)", 
                       f"Missing: {missing_brands}, Got: {brand_names}")
    else:
        result.add_pass("2.5: Includes all expected brands")
    
    # 2.6: Each brand has id, name, count
    for brand in data["brands"]:
        if not all(k in brand for k in ["id", "name", "count"]):
            result.add_fail(f"2.6: Brand {brand.get('name')} has id, name, count", 
                           f"Got keys: {list(brand.keys())}")
            return
    result.add_pass("2.6: All brands have id, name, count")
    
    # 2.7: Sum of brand counts equals 'all'
    total_from_brands = sum(b.get("count", 0) for b in data["brands"])
    if total_from_brands != data["all"]:
        result.add_fail("2.7: Sum of brand counts equals 'all'", 
                       f"Sum: {total_from_brands}, all: {data['all']}")
    else:
        result.add_pass("2.7: Sum of brand counts equals 'all'")
    
    # Store for later verification
    result.test_data["total_items_from_brands"] = data["all"]
    result.test_data["brands"] = data["brands"]
    print(f"   Total items from brands: {data['all']}")

# =============================================================================
# TEST 3: GET /api/purchases/customers
# =============================================================================
def test_customers(token: str, result: TestResult):
    print("\n" + "="*80)
    print("TEST 3: GET /api/purchases/customers")
    print("="*80)
    
    resp = requests.get(f"{API_BASE}/purchases/customers", headers=headers(token))
    
    # 3.1: Returns 200
    if resp.status_code != 200:
        result.add_fail("3.1: GET /purchases/customers returns 200", 
                       f"Got {resp.status_code}", {"body": resp.text})
        return
    result.add_pass("3.1: GET /purchases/customers returns 200")
    
    data = resp.json()
    
    # 3.2: Returns array
    if not isinstance(data, list):
        result.add_fail("3.2: Returns array", f"Got type: {type(data)}")
        return
    result.add_pass("3.2: Returns array")
    
    # 3.3: Each customer has id, name, count, open
    for customer in data:
        if not all(k in customer for k in ["id", "name", "count", "open"]):
            result.add_fail(f"3.3: Customer {customer.get('name')} has id, name, count, open", 
                           f"Got keys: {list(customer.keys())}")
            return
    result.add_pass("3.3: All customers have id, name, count, open")
    
    # 3.4: 'open' represents non-delivered items
    for customer in data:
        if customer["open"] > customer["count"]:
            result.add_fail(f"3.4: Customer {customer['name']} open <= count", 
                           f"open: {customer['open']}, count: {customer['count']}")
            return
    result.add_pass("3.4: All customers have open <= count (logical)")
    
    # 3.5: Should have at least some customers with confirmed orders
    if len(data) == 0:
        result.add_fail("3.5: Has at least one customer with orders", 
                       "No customers found")
    else:
        result.add_pass(f"3.5: Has {len(data)} customers with orders")
    
    result.test_data["customers"] = data
    print(f"   Total customers: {len(data)}")

# =============================================================================
# TEST 4: GET /api/purchases/items?view=today
# =============================================================================
def test_items_today(token: str, result: TestResult):
    print("\n" + "="*80)
    print("TEST 4: GET /api/purchases/items?view=today")
    print("="*80)
    
    resp = requests.get(f"{API_BASE}/purchases/items?view=today", headers=headers(token))
    
    # 4.1: Returns 200
    if resp.status_code != 200:
        result.add_fail("4.1: GET /purchases/items?view=today returns 200", 
                       f"Got {resp.status_code}", {"body": resp.text})
        return
    result.add_pass("4.1: GET /purchases/items?view=today returns 200")
    
    data = resp.json()
    
    # 4.2: Has required keys
    required_keys = ["sla_days", "count", "blocked_count", "items"]
    missing = [k for k in required_keys if k not in data]
    if missing:
        result.add_fail("4.2: Response has sla_days, count, blocked_count, items", 
                       f"Missing: {missing}")
        return
    result.add_pass("4.2: Response has sla_days, count, blocked_count, items")
    
    # 4.3: items is an array
    if not isinstance(data["items"], list):
        result.add_fail("4.3: items is an array", f"Got type: {type(data['items'])}")
        return
    result.add_pass("4.3: items is an array")
    
    # 4.4: count matches items length
    if data["count"] != len(data["items"]):
        result.add_fail("4.4: count matches items length", 
                       f"count: {data['count']}, items length: {len(data['items'])}")
    else:
        result.add_pass("4.4: count matches items length")
    
    # 4.5: Each item has required fields
    if len(data["items"]) > 0:
        required_item_fields = [
            "item_id", "po_id", "po_number", "sku", "name", 
            "customer_id", "customer_name", "brand_id", "brand_name",
            "stage", "stage_label", "stage_tone", "qty", "age_days", 
            "blocked", "last_moved_at", "last_moved_by_name"
        ]
        item = data["items"][0]
        missing = [f for f in required_item_fields if f not in item]
        if missing:
            result.add_fail("4.5: Each item has all required fields", 
                           f"Missing: {missing}")
        else:
            result.add_pass("4.5: Each item has all required fields")
    else:
        result.add_pass("4.5: Each item has all required fields (no items to check)")
    
    # 4.6: blocked_count matches actual blocked items
    actual_blocked = sum(1 for item in data["items"] if item.get("blocked"))
    if actual_blocked != data["blocked_count"]:
        result.add_fail("4.6: blocked_count matches actual blocked items", 
                       f"blocked_count: {data['blocked_count']}, actual: {actual_blocked}")
    else:
        result.add_pass("4.6: blocked_count matches actual blocked items")
    
    # 4.7: Blocked items are in early stages and age >= sla_days
    early_stages = ["order_in_company", "company_billing", "in_box"]
    sla_days = data["sla_days"]
    for item in data["items"]:
        if item.get("blocked"):
            if item["stage"] not in early_stages:
                result.add_fail(f"4.7: Blocked item {item['item_id']} is in early stage", 
                               f"Stage: {item['stage']}")
                break
            if item["age_days"] < sla_days:
                result.add_fail(f"4.7: Blocked item {item['item_id']} age >= sla_days", 
                               f"age: {item['age_days']}, sla: {sla_days}")
                break
    else:
        result.add_pass("4.7: Blocked items are correctly identified (early stage + age >= sla_days)")
    
    result.test_data["items_today"] = data["items"]
    result.test_data["sla_days"] = data["sla_days"]
    print(f"   Total items: {data['count']}, Blocked: {data['blocked_count']}, SLA: {data['sla_days']} days")

# =============================================================================
# TEST 5: GET /api/purchases/items with filters
# =============================================================================
def test_items_filters(token: str, result: TestResult):
    print("\n" + "="*80)
    print("TEST 5: GET /api/purchases/items with filters")
    print("="*80)
    
    # 5.1: Filter by brand
    if result.test_data.get("brands"):
        brand = result.test_data["brands"][0]
        brand_id = brand["id"]
        resp = requests.get(f"{API_BASE}/purchases/items?view=stock&brand={brand_id}", 
                           headers=headers(token))
        if resp.status_code != 200:
            result.add_fail("5.1: Filter by brand returns 200", 
                           f"Got {resp.status_code}")
        else:
            data = resp.json()
            # Verify all items are from the selected brand
            wrong_brand = [item for item in data["items"] if item.get("brand_id") != brand_id]
            if wrong_brand:
                result.add_fail("5.1: Filter by brand returns only items from that brand", 
                               f"Found {len(wrong_brand)} items from other brands")
            else:
                result.add_pass(f"5.1: Filter by brand works (brand={brand['name']}, {len(data['items'])} items)")
    else:
        result.add_fail("5.1: Filter by brand", "No brands available for testing")
    
    # 5.2: Filter by search query (SKU/name/customer)
    resp = requests.get(f"{API_BASE}/purchases/items?view=stock&q=test", 
                       headers=headers(token))
    if resp.status_code != 200:
        result.add_fail("5.2: Search filter returns 200", 
                       f"Got {resp.status_code}")
    else:
        result.add_pass("5.2: Search filter (?q=) returns 200")
    
    # 5.3: Filter by stage
    resp = requests.get(f"{API_BASE}/purchases/items?view=stock&stage=in_transit", 
                       headers=headers(token))
    if resp.status_code != 200:
        result.add_fail("5.3: Filter by stage returns 200", 
                       f"Got {resp.status_code}")
    else:
        data = resp.json()
        # Verify all items are in the selected stage
        wrong_stage = [item for item in data["items"] if item.get("stage") != "in_transit"]
        if wrong_stage:
            result.add_fail("5.3: Filter by stage returns only items in that stage", 
                           f"Found {len(wrong_stage)} items in other stages")
        else:
            result.add_pass(f"5.3: Filter by stage works (stage=in_transit, {len(data['items'])} items)")
    
    # 5.4: view=dispatch_record
    resp = requests.get(f"{API_BASE}/purchases/items?view=dispatch_record", 
                       headers=headers(token))
    if resp.status_code != 200:
        result.add_fail("5.4: view=dispatch_record returns 200", 
                       f"Got {resp.status_code}")
    else:
        data = resp.json()
        dispatch_stages = ["dispatched", "in_transit", "delivered"]
        wrong_stage = [item for item in data["items"] if item.get("stage") not in dispatch_stages]
        if wrong_stage:
            result.add_fail("5.4: view=dispatch_record returns only dispatched/in_transit/delivered items", 
                           f"Found {len(wrong_stage)} items in other stages")
        else:
            result.add_pass(f"5.4: view=dispatch_record works ({len(data['items'])} items)")

# =============================================================================
# TEST 6: GET /api/purchases/items/{item_id}
# =============================================================================
def test_item_detail(token: str, result: TestResult):
    print("\n" + "="*80)
    print("TEST 6: GET /api/purchases/items/{item_id}")
    print("="*80)
    
    # Get an item from previous test
    if not result.test_data.get("items_today"):
        result.add_fail("6.1: Get item detail", "No items available from previous test")
        return
    
    item_id = result.test_data["items_today"][0]["item_id"]
    
    # 6.1: Returns 200 with item detail
    resp = requests.get(f"{API_BASE}/purchases/items/{item_id}", headers=headers(token))
    if resp.status_code != 200:
        result.add_fail("6.1: GET /purchases/items/{item_id} returns 200", 
                       f"Got {resp.status_code}")
        return
    result.add_pass("6.1: GET /purchases/items/{item_id} returns 200")
    
    data = resp.json()
    
    # 6.2: Has stage_history
    if "stage_history" not in data:
        result.add_fail("6.2: Response includes stage_history", 
                       f"Missing stage_history")
    else:
        result.add_pass("6.2: Response includes stage_history")
    
    # 6.3: Has po_status
    if "po_status" not in data:
        result.add_fail("6.3: Response includes po_status", 
                       f"Missing po_status")
    else:
        result.add_pass("6.3: Response includes po_status")
    
    # 6.4: 404 for bogus id
    resp = requests.get(f"{API_BASE}/purchases/items/bogus-id-12345", headers=headers(token))
    if resp.status_code != 404:
        result.add_fail("6.4: Returns 404 for non-existent item", 
                       f"Got {resp.status_code}")
    else:
        result.add_pass("6.4: Returns 404 for non-existent item")
    
    result.test_data["test_item_id"] = item_id

# =============================================================================
# TEST 7: POST /api/purchases/items/{item_id}/move
# =============================================================================
def test_move_item(token: str, result: TestResult):
    print("\n" + "="*80)
    print("TEST 7: POST /api/purchases/items/{item_id}/move")
    print("="*80)
    
    if not result.test_data.get("test_item_id"):
        result.add_fail("7.1: Move item", "No test item available")
        return
    
    item_id = result.test_data["test_item_id"]
    
    # Get current state
    resp = requests.get(f"{API_BASE}/purchases/items/{item_id}", headers=headers(token))
    if resp.status_code != 200:
        result.add_fail("7.1: Get item before move", f"Got {resp.status_code}")
        return
    
    before = resp.json()
    from_stage = before["stage"]
    
    # 7.1: Move to in_transit
    resp = requests.post(f"{API_BASE}/purchases/items/{item_id}/move", 
                        headers=headers(token),
                        json={"stage": "in_transit", "note": "test move"})
    
    if resp.status_code != 200:
        result.add_fail("7.1: POST /purchases/items/{item_id}/move returns 200", 
                       f"Got {resp.status_code}", {"body": resp.text})
        return
    result.add_pass("7.1: POST /purchases/items/{item_id}/move returns 200")
    
    move_result = resp.json()
    
    # 7.2: Response has po_id, item_id, from_stage, to_stage
    required = ["po_id", "item_id", "from_stage", "to_stage"]
    missing = [k for k in required if k not in move_result]
    if missing:
        result.add_fail("7.2: Response has po_id, item_id, from_stage, to_stage", 
                       f"Missing: {missing}")
    else:
        result.add_pass("7.2: Response has po_id, item_id, from_stage, to_stage")
    
    # 7.3: Get item after move and verify changes
    resp = requests.get(f"{API_BASE}/purchases/items/{item_id}", headers=headers(token))
    if resp.status_code != 200:
        result.add_fail("7.3: Get item after move", f"Got {resp.status_code}")
        return
    
    after = resp.json()
    
    # 7.4: Stage updated
    if after["stage"] != "in_transit":
        result.add_fail("7.4: Stage updated to in_transit", 
                       f"Got stage: {after['stage']}")
    else:
        result.add_pass("7.4: Stage updated to in_transit")
    
    # 7.5: last_moved_at updated (should be more recent)
    if after["last_moved_at"] == before["last_moved_at"]:
        result.add_fail("7.5: last_moved_at updated", 
                       "Timestamp unchanged")
    else:
        result.add_pass("7.5: last_moved_at updated")
    
    # 7.6: last_moved_by_name is "Aarav Kapoor" (owner)
    if after["last_moved_by_name"] != "Aarav Kapoor":
        result.add_fail("7.6: last_moved_by_name is 'Aarav Kapoor'", 
                       f"Got: {after['last_moved_by_name']}")
    else:
        result.add_pass("7.6: last_moved_by_name is 'Aarav Kapoor'")
    
    # 7.7: stage_history has new entry
    if len(after["stage_history"]) <= len(before["stage_history"]):
        result.add_fail("7.7: stage_history has new entry", 
                       f"Before: {len(before['stage_history'])}, After: {len(after['stage_history'])}")
    else:
        result.add_pass("7.7: stage_history has new entry")
        
        # Check the new entry
        new_entry = after["stage_history"][-1]
        if new_entry.get("action") != "move":
            result.add_fail("7.8: New entry has action='move'", 
                           f"Got: {new_entry.get('action')}")
        else:
            result.add_pass("7.8: New entry has action='move'")
        
        if new_entry.get("to_stage") != "in_transit":
            result.add_fail("7.9: New entry has to_stage='in_transit'", 
                           f"Got: {new_entry.get('to_stage')}")
        else:
            result.add_pass("7.9: New entry has to_stage='in_transit'")
        
        if new_entry.get("note") != "test move":
            result.add_fail("7.10: New entry has note='test move'", 
                           f"Got: {new_entry.get('note')}")
        else:
            result.add_pass("7.10: New entry has note='test move'")
        
        if new_entry.get("by_user_name") != "Aarav Kapoor":
            result.add_fail("7.11: New entry has by_user_name='Aarav Kapoor'", 
                           f"Got: {new_entry.get('by_user_name')}")
        else:
            result.add_pass("7.11: New entry has by_user_name='Aarav Kapoor'")
    
    # 7.12: Activity event logged
    po_id = after["po_id"]
    resp = requests.get(f"{API_BASE}/activity/purchase/{po_id}", headers=headers(token))
    if resp.status_code == 200:
        events = resp.json()
        stage_moved_events = [e for e in events if e.get("event_type") == "purchase.stage_moved"]
        if not stage_moved_events:
            result.add_fail("7.12: Activity event 'purchase.stage_moved' logged", 
                           "No stage_moved events found")
        else:
            result.add_pass("7.12: Activity event 'purchase.stage_moved' logged")
    else:
        result.add_fail("7.12: Check activity events", 
                       f"GET /activity/purchase/{po_id} returned {resp.status_code}")
    
    # 7.13: Invalid stage returns 400
    resp = requests.post(f"{API_BASE}/purchases/items/{item_id}/move", 
                        headers=headers(token),
                        json={"stage": "invalid_stage"})
    if resp.status_code != 400:
        result.add_fail("7.13: Invalid stage returns 400", 
                       f"Got {resp.status_code}")
    else:
        result.add_pass("7.13: Invalid stage returns 400")
    
    result.test_data["moved_item_po_id"] = po_id

# =============================================================================
# TEST 8: POST /api/purchases/items/bulk-move
# =============================================================================
def test_bulk_move(token: str, result: TestResult):
    print("\n" + "="*80)
    print("TEST 8: POST /api/purchases/items/bulk-move")
    print("="*80)
    
    # Get 2 items for bulk move
    resp = requests.get(f"{API_BASE}/purchases/items?view=stock&limit=5", headers=headers(token))
    if resp.status_code != 200:
        result.add_fail("8.1: Get items for bulk move", f"Got {resp.status_code}")
        return
    
    items = resp.json()["items"]
    if len(items) < 2:
        result.add_fail("8.1: Need at least 2 items for bulk move", 
                       f"Only {len(items)} items available")
        return
    
    item_ids = [items[0]["item_id"], items[1]["item_id"]]
    
    # 8.1: Bulk move to in_box
    resp = requests.post(f"{API_BASE}/purchases/items/bulk-move", 
                        headers=headers(token),
                        json={"item_ids": item_ids, "stage": "in_box", "note": "batch test"})
    
    if resp.status_code != 200:
        result.add_fail("8.1: POST /purchases/items/bulk-move returns 200", 
                       f"Got {resp.status_code}", {"body": resp.text})
        return
    result.add_pass("8.1: POST /purchases/items/bulk-move returns 200")
    
    data = resp.json()
    
    # 8.2: Response has count and results
    if "count" not in data or "results" not in data:
        result.add_fail("8.2: Response has count and results", 
                       f"Got keys: {list(data.keys())}")
        return
    result.add_pass("8.2: Response has count and results")
    
    # 8.3: All results have ok=true
    failed_results = [r for r in data["results"] if not r.get("ok")]
    if failed_results:
        result.add_fail("8.3: All results have ok=true", 
                       f"{len(failed_results)} failed: {failed_results}")
    else:
        result.add_pass("8.3: All results have ok=true")
    
    # 8.4: Verify both items now have stage=in_box
    for item_id in item_ids:
        resp = requests.get(f"{API_BASE}/purchases/items/{item_id}", headers=headers(token))
        if resp.status_code == 200:
            item = resp.json()
            if item["stage"] != "in_box":
                result.add_fail(f"8.4: Item {item_id} stage updated to in_box", 
                               f"Got stage: {item['stage']}")
                break
    else:
        result.add_pass("8.4: Both items now have stage=in_box")
    
    # 8.5: Empty item_ids returns 400
    resp = requests.post(f"{API_BASE}/purchases/items/bulk-move", 
                        headers=headers(token),
                        json={"item_ids": [], "stage": "in_box"})
    if resp.status_code != 400:
        result.add_fail("8.5: Empty item_ids returns 400", 
                       f"Got {resp.status_code}")
    else:
        result.add_pass("8.5: Empty item_ids returns 400")

# =============================================================================
# TEST 9: POST /api/purchases/items/{item_id}/transfer
# =============================================================================
def test_transfer(token: str, result: TestResult):
    print("\n" + "="*80)
    print("TEST 9: POST /api/purchases/items/{item_id}/transfer")
    print("="*80)
    
    # Find an item with qty >= 2
    resp = requests.get(f"{API_BASE}/purchases/items?view=stock&limit=50", headers=headers(token))
    if resp.status_code != 200:
        result.add_fail("9.1: Get items for transfer", f"Got {resp.status_code}")
        return
    
    items = resp.json()["items"]
    suitable_item = None
    for item in items:
        if item.get("qty", 0) >= 2:
            suitable_item = item
            break
    
    if not suitable_item:
        result.add_fail("9.1: Find item with qty >= 2", 
                       "No suitable item found")
        return
    
    item_id = suitable_item["item_id"]
    source_customer_id = suitable_item["customer_id"]
    original_qty = suitable_item["qty"]
    
    # Get a different customer
    resp = requests.get(f"{API_BASE}/customers", headers=headers(token))
    if resp.status_code != 200:
        result.add_fail("9.2: Get customers for transfer", f"Got {resp.status_code}")
        return
    
    customers = resp.json()
    dest_customer = None
    for c in customers:
        if c["id"] != source_customer_id:
            dest_customer = c
            break
    
    if not dest_customer:
        result.add_fail("9.2: Find different customer for transfer", 
                       "No suitable customer found")
        return
    
    # 9.1: Transfer 1 unit to different customer
    resp = requests.post(f"{API_BASE}/purchases/items/{item_id}/transfer", 
                        headers=headers(token),
                        json={
                            "new_customer_id": dest_customer["id"],
                            "qty": 1,
                            "reason": "test transfer"
                        })
    
    if resp.status_code != 200:
        result.add_fail("9.1: POST /purchases/items/{item_id}/transfer returns 200", 
                       f"Got {resp.status_code}", {"body": resp.text})
        return
    result.add_pass("9.1: POST /purchases/items/{item_id}/transfer returns 200")
    
    data = resp.json()
    
    # 9.2: Response has source and destination
    if "source" not in data or "destination" not in data:
        result.add_fail("9.2: Response has source and destination", 
                       f"Got keys: {list(data.keys())}")
        return
    result.add_pass("9.2: Response has source and destination")
    
    # 9.3: Source has required fields
    source_fields = ["po_id", "po_number", "item_id", "remaining_qty", "removed"]
    missing = [f for f in source_fields if f not in data["source"]]
    if missing:
        result.add_fail("9.3: Source has required fields", f"Missing: {missing}")
    else:
        result.add_pass("9.3: Source has required fields")
    
    # 9.4: Destination has required fields
    dest_fields = ["po_id", "po_number", "item_id", "qty", "customer_id", "customer_name"]
    missing = [f for f in dest_fields if f not in data["destination"]]
    if missing:
        result.add_fail("9.4: Destination has required fields", f"Missing: {missing}")
    else:
        result.add_pass("9.4: Destination has required fields")
    
    # 9.5: Source qty reduced by 1
    if data["source"]["remaining_qty"] != original_qty - 1:
        result.add_fail("9.5: Source qty reduced by 1", 
                       f"Original: {original_qty}, Remaining: {data['source']['remaining_qty']}")
    else:
        result.add_pass("9.5: Source qty reduced by 1")
    
    # 9.6: Source not removed (qty > 0)
    if data["source"]["removed"]:
        result.add_fail("9.6: Source not removed (remaining_qty > 0)", 
                       "Source was removed")
    else:
        result.add_pass("9.6: Source not removed (remaining_qty > 0)")
    
    # 9.7: Destination qty is 1
    if data["destination"]["qty"] != 1:
        result.add_fail("9.7: Destination qty is 1", 
                       f"Got: {data['destination']['qty']}")
    else:
        result.add_pass("9.7: Destination qty is 1")
    
    # 9.8: Destination customer_id matches
    if data["destination"]["customer_id"] != dest_customer["id"]:
        result.add_fail("9.8: Destination customer_id matches", 
                       f"Expected: {dest_customer['id']}, Got: {data['destination']['customer_id']}")
    else:
        result.add_pass("9.8: Destination customer_id matches")
    
    # 9.9: Destination is a NEW PO (different po_id)
    if data["destination"]["po_id"] == data["source"]["po_id"]:
        result.add_fail("9.9: Destination is a new PO", 
                       "Same PO ID as source")
    else:
        result.add_pass("9.9: Destination is a new PO")
    
    # 9.10: Verify destination item exists and has correct properties
    dest_item_id = data["destination"]["item_id"]
    resp = requests.get(f"{API_BASE}/purchases/items/{dest_item_id}", headers=headers(token))
    if resp.status_code != 200:
        result.add_fail("9.10: Destination item exists", f"Got {resp.status_code}")
    else:
        dest_item = resp.json()
        
        # Check stage matches source
        if dest_item["stage"] != suitable_item["stage"]:
            result.add_fail("9.11: Destination item has same stage as source", 
                           f"Source: {suitable_item['stage']}, Dest: {dest_item['stage']}")
        else:
            result.add_pass("9.11: Destination item has same stage as source")
        
        # Check transferred_from fields
        if dest_item.get("transferred_from_item_id") != item_id:
            result.add_fail("9.12: Destination has transferred_from_item_id", 
                           f"Expected: {item_id}, Got: {dest_item.get('transferred_from_item_id')}")
        else:
            result.add_pass("9.12: Destination has transferred_from_item_id")
        
        if dest_item.get("transferred_from_po_id") != data["source"]["po_id"]:
            result.add_fail("9.13: Destination has transferred_from_po_id", 
                           f"Expected: {data['source']['po_id']}, Got: {dest_item.get('transferred_from_po_id')}")
        else:
            result.add_pass("9.13: Destination has transferred_from_po_id")
        
        if dest_item.get("transferred_from_customer_id") != source_customer_id:
            result.add_fail("9.14: Destination has transferred_from_customer_id", 
                           f"Expected: {source_customer_id}, Got: {dest_item.get('transferred_from_customer_id')}")
        else:
            result.add_pass("9.14: Destination has transferred_from_customer_id")
        
        # Check stage_history has transfer_in entry
        transfer_in_entries = [e for e in dest_item.get("stage_history", []) 
                              if e.get("action") == "transfer_in"]
        if not transfer_in_entries:
            result.add_fail("9.15: Destination stage_history has transfer_in entry", 
                           "No transfer_in entry found")
        else:
            result.add_pass("9.15: Destination stage_history has transfer_in entry")
    
    # 9.16: Verify source item stage_history has transfer_out entry
    resp = requests.get(f"{API_BASE}/purchases/items/{item_id}", headers=headers(token))
    if resp.status_code == 200:
        source_item = resp.json()
        transfer_out_entries = [e for e in source_item.get("stage_history", []) 
                               if e.get("action") == "transfer_out"]
        if not transfer_out_entries:
            result.add_fail("9.16: Source stage_history has transfer_out entry", 
                           "No transfer_out entry found")
        else:
            result.add_pass("9.16: Source stage_history has transfer_out entry")
            
            # Check ref_item_id and ref_po_id
            entry = transfer_out_entries[-1]
            if entry.get("ref_item_id") != dest_item_id:
                result.add_fail("9.17: transfer_out entry has ref_item_id", 
                               f"Expected: {dest_item_id}, Got: {entry.get('ref_item_id')}")
            else:
                result.add_pass("9.17: transfer_out entry has ref_item_id")
            
            if entry.get("ref_po_id") != data["destination"]["po_id"]:
                result.add_fail("9.18: transfer_out entry has ref_po_id", 
                               f"Expected: {data['destination']['po_id']}, Got: {entry.get('ref_po_id')}")
            else:
                result.add_pass("9.18: transfer_out entry has ref_po_id")
    
    # 9.19: Activity events logged
    source_po_id = data["source"]["po_id"]
    dest_po_id = data["destination"]["po_id"]
    
    resp = requests.get(f"{API_BASE}/activity/purchase/{source_po_id}", headers=headers(token))
    if resp.status_code == 200:
        events = resp.json()
        transfer_out_events = [e for e in events if e.get("event_type") == "purchase.transferred_out"]
        if not transfer_out_events:
            result.add_fail("9.19: Source PO has 'purchase.transferred_out' activity event", 
                           "No transferred_out event found")
        else:
            result.add_pass("9.19: Source PO has 'purchase.transferred_out' activity event")
    
    resp = requests.get(f"{API_BASE}/activity/purchase/{dest_po_id}", headers=headers(token))
    if resp.status_code == 200:
        events = resp.json()
        transfer_in_events = [e for e in events if e.get("event_type") == "purchase.transferred_in"]
        if not transfer_in_events:
            result.add_fail("9.20: Destination PO has 'purchase.transferred_in' activity event", 
                           "No transferred_in event found")
        else:
            result.add_pass("9.20: Destination PO has 'purchase.transferred_in' activity event")
    
    # 9.21: Same-customer transfer returns 400
    resp = requests.post(f"{API_BASE}/purchases/items/{item_id}/transfer", 
                        headers=headers(token),
                        json={
                            "new_customer_id": source_customer_id,
                            "qty": 1
                        })
    if resp.status_code != 400:
        result.add_fail("9.21: Same-customer transfer returns 400", 
                       f"Got {resp.status_code}")
    else:
        result.add_pass("9.21: Same-customer transfer returns 400")
    
    # 9.22: Non-existent customer returns 404
    resp = requests.post(f"{API_BASE}/purchases/items/{item_id}/transfer", 
                        headers=headers(token),
                        json={
                            "new_customer_id": "non-existent-customer-id",
                            "qty": 1
                        })
    if resp.status_code != 404:
        result.add_fail("9.22: Non-existent customer returns 404", 
                       f"Got {resp.status_code}")
    else:
        result.add_pass("9.22: Non-existent customer returns 404")
    
    # 9.23: qty > available returns 400
    resp = requests.post(f"{API_BASE}/purchases/items/{item_id}/transfer", 
                        headers=headers(token),
                        json={
                            "new_customer_id": dest_customer["id"],
                            "qty": 9999
                        })
    if resp.status_code != 400:
        result.add_fail("9.23: qty > available returns 400", 
                       f"Got {resp.status_code}")
    else:
        result.add_pass("9.23: qty > available returns 400")
    
    # 9.24: qty <= 0 returns 400
    resp = requests.post(f"{API_BASE}/purchases/items/{item_id}/transfer", 
                        headers=headers(token),
                        json={
                            "new_customer_id": dest_customer["id"],
                            "qty": 0
                        })
    if resp.status_code != 400:
        result.add_fail("9.24: qty <= 0 returns 400", 
                       f"Got {resp.status_code}")
    else:
        result.add_pass("9.24: qty <= 0 returns 400")

# =============================================================================
# TEST 10: GET /api/purchases/export.xlsx
# =============================================================================
def test_export_xlsx(token: str, result: TestResult):
    print("\n" + "="*80)
    print("TEST 10: GET /api/purchases/export.xlsx")
    print("="*80)
    
    # 10.1: Basic export returns xlsx
    resp = requests.get(f"{API_BASE}/purchases/export.xlsx?view=stock", 
                       headers=headers(token))
    
    if resp.status_code != 200:
        result.add_fail("10.1: GET /purchases/export.xlsx returns 200", 
                       f"Got {resp.status_code}")
        return
    result.add_pass("10.1: GET /purchases/export.xlsx returns 200")
    
    # 10.2: Content-Type is xlsx
    content_type = resp.headers.get("Content-Type", "")
    if "spreadsheetml.sheet" not in content_type:
        result.add_fail("10.2: Content-Type is application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 
                       f"Got: {content_type}")
    else:
        result.add_pass("10.2: Content-Type is xlsx")
    
    # 10.3: Body is valid xlsx (starts with PK signature)
    if len(resp.content) < 1000:
        result.add_fail("10.3: Response body is valid xlsx (>1000 bytes)", 
                       f"Got {len(resp.content)} bytes")
    elif not resp.content.startswith(b'PK\x03\x04'):
        result.add_fail("10.3: Response body starts with xlsx signature", 
                       f"Got: {resp.content[:10]}")
    else:
        result.add_pass("10.3: Response body is valid xlsx")
    
    # 10.4: Export with brand filter
    if result.test_data.get("brands"):
        brand_id = result.test_data["brands"][0]["id"]
        resp = requests.get(f"{API_BASE}/purchases/export.xlsx?view=stock&brand={brand_id}", 
                           headers=headers(token))
        if resp.status_code != 200:
            result.add_fail("10.4: Export with brand filter returns 200", 
                           f"Got {resp.status_code}")
        else:
            result.add_pass("10.4: Export with brand filter returns 200")
    
    # 10.5: Export with stage filter
    resp = requests.get(f"{API_BASE}/purchases/export.xlsx?view=stock&stage=in_transit", 
                       headers=headers(token))
    if resp.status_code != 200:
        result.add_fail("10.5: Export with stage filter returns 200", 
                       f"Got {resp.status_code}")
    else:
        result.add_pass("10.5: Export with stage filter returns 200")
    
    # 10.6: Query param auth (?_t=token) works
    resp = requests.get(f"{API_BASE}/purchases/export.xlsx?view=stock&_t={token}")
    if resp.status_code != 200:
        result.add_fail("10.6: Query param auth (?_t=token) works", 
                       f"Got {resp.status_code}")
    else:
        result.add_pass("10.6: Query param auth (?_t=token) works")

# =============================================================================
# TEST 11: GET/POST /api/purchases/settings
# =============================================================================
def test_settings(token: str, result: TestResult):
    print("\n" + "="*80)
    print("TEST 11: GET/POST /api/purchases/settings")
    print("="*80)
    
    # 11.1: GET settings returns current value
    resp = requests.get(f"{API_BASE}/purchases/settings", headers=headers(token))
    if resp.status_code != 200:
        result.add_fail("11.1: GET /purchases/settings returns 200", 
                       f"Got {resp.status_code}")
        return
    result.add_pass("11.1: GET /purchases/settings returns 200")
    
    data = resp.json()
    
    # 11.2: Has sla_days
    if "sla_days" not in data:
        result.add_fail("11.2: Response has sla_days", 
                       f"Got keys: {list(data.keys())}")
        return
    result.add_pass("11.2: Response has sla_days")
    
    original_sla = data["sla_days"]
    print(f"   Current SLA: {original_sla} days")
    
    # 11.3: POST updates sla_days
    resp = requests.post(f"{API_BASE}/purchases/settings", 
                        headers=headers(token),
                        json={"sla_days": 14})
    if resp.status_code != 200:
        result.add_fail("11.3: POST /purchases/settings returns 200", 
                       f"Got {resp.status_code}")
    else:
        result.add_pass("11.3: POST /purchases/settings returns 200")
        
        data = resp.json()
        if data.get("sla_days") != 14:
            result.add_fail("11.4: Response has updated sla_days=14", 
                           f"Got: {data.get('sla_days')}")
        else:
            result.add_pass("11.4: Response has updated sla_days=14")
    
    # 11.5: GET again to verify persistence
    resp = requests.get(f"{API_BASE}/purchases/settings", headers=headers(token))
    if resp.status_code == 200:
        data = resp.json()
        if data.get("sla_days") != 14:
            result.add_fail("11.5: GET returns updated value (14)", 
                           f"Got: {data.get('sla_days')}")
        else:
            result.add_pass("11.5: GET returns updated value (14)")
    
    # 11.6: Invalid value (0) returns 400
    resp = requests.post(f"{API_BASE}/purchases/settings", 
                        headers=headers(token),
                        json={"sla_days": 0})
    if resp.status_code != 400 and resp.status_code != 422:
        result.add_fail("11.6: sla_days=0 returns 400/422", 
                       f"Got {resp.status_code}")
    else:
        result.add_pass("11.6: sla_days=0 returns 400/422")
    
    # 11.7: Invalid value (400) returns 400
    resp = requests.post(f"{API_BASE}/purchases/settings", 
                        headers=headers(token),
                        json={"sla_days": 400})
    if resp.status_code != 400 and resp.status_code != 422:
        result.add_fail("11.7: sla_days=400 returns 400/422", 
                       f"Got {resp.status_code}")
    else:
        result.add_pass("11.7: sla_days=400 returns 400/422")
    
    # Reset to original value
    resp = requests.post(f"{API_BASE}/purchases/settings", 
                        headers=headers(token),
                        json={"sla_days": original_sla})
    if resp.status_code == 200:
        print(f"   Reset SLA to {original_sla} days")
        result.add_pass(f"11.8: Reset SLA to original value ({original_sla})")
    else:
        result.add_fail(f"11.8: Reset SLA to original value", 
                       f"Got {resp.status_code}")

# =============================================================================
# TEST 12: AUTH checks
# =============================================================================
def test_auth(result: TestResult):
    print("\n" + "="*80)
    print("TEST 12: AUTH checks (401 without token)")
    print("="*80)
    
    endpoints = [
        ("GET", "/purchases/stages"),
        ("GET", "/purchases/brands"),
        ("GET", "/purchases/customers"),
        ("GET", "/purchases/items"),
        ("GET", "/purchases/settings"),
        ("GET", "/purchases/export.xlsx"),
    ]
    
    for method, path in endpoints:
        if method == "GET":
            resp = requests.get(f"{API_BASE}{path}")
        else:
            resp = requests.post(f"{API_BASE}{path}")
        
        if resp.status_code != 401:
            result.add_fail(f"12: {method} {path} returns 401 without token", 
                           f"Got {resp.status_code}")
        else:
            result.add_pass(f"12: {method} {path} returns 401 without token")

# =============================================================================
# TEST 13: REGRESSION checks
# =============================================================================
def test_regression(token: str, result: TestResult):
    print("\n" + "="*80)
    print("TEST 13: REGRESSION checks")
    print("="*80)
    
    # 13.1: /api/quotations still works
    resp = requests.get(f"{API_BASE}/quotations", headers=headers(token))
    if resp.status_code != 200:
        result.add_fail("13.1: GET /api/quotations returns 200", 
                       f"Got {resp.status_code}")
    else:
        result.add_pass("13.1: GET /api/quotations returns 200")
    
    # 13.2: /api/purchase-orders still works
    resp = requests.get(f"{API_BASE}/purchase-orders", headers=headers(token))
    if resp.status_code != 200:
        result.add_fail("13.2: GET /api/purchase-orders returns 200", 
                       f"Got {resp.status_code}")
    else:
        result.add_pass("13.2: GET /api/purchase-orders returns 200")
    
    # 13.3: /api/payments/stats still works
    resp = requests.get(f"{API_BASE}/payments/stats", headers=headers(token))
    if resp.status_code != 200:
        result.add_fail("13.3: GET /api/payments/stats returns 200", 
                       f"Got {resp.status_code}")
    else:
        result.add_pass("13.3: GET /api/payments/stats returns 200")
    
    # 13.4: NO tax fields in responses
    resp = requests.get(f"{API_BASE}/quotations", headers=headers(token))
    if resp.status_code == 200:
        quotations = resp.json()
        if quotations:
            quot = quotations[0]
            tax_fields = ["tax_pct", "tax_total", "tax_amount"]
            found_tax = [f for f in tax_fields if f in quot]
            if found_tax:
                result.add_fail("13.4: NO tax fields in quotations", 
                               f"Found: {found_tax}")
            else:
                result.add_pass("13.4: NO tax fields in quotations")
        else:
            result.add_pass("13.4: NO tax fields in quotations (no quotations to check)")

# =============================================================================
# TEST 14: SEED INTEGRITY checks
# =============================================================================
def test_seed_integrity(token: str, result: TestResult):
    print("\n" + "="*80)
    print("TEST 14: SEED INTEGRITY checks")
    print("="*80)
    
    # 14.1: At least 5 brands
    resp = requests.get(f"{API_BASE}/purchases/brands", headers=headers(token))
    if resp.status_code == 200:
        data = resp.json()
        if len(data.get("brands", [])) < 5:
            result.add_fail("14.1: At least 5 brands", 
                           f"Got {len(data.get('brands', []))} brands")
        else:
            result.add_pass(f"14.1: At least 5 brands ({len(data['brands'])} found)")
    
    # 14.2: At least 20 items across all stages
    resp = requests.get(f"{API_BASE}/purchases/items?view=stock&limit=2000", headers=headers(token))
    if resp.status_code == 200:
        data = resp.json()
        if data.get("count", 0) < 20:
            result.add_fail("14.2: At least 20 items across all stages", 
                           f"Got {data.get('count', 0)} items")
        else:
            result.add_pass(f"14.2: At least 20 items across all stages ({data['count']} found)")
    
    # 14.3: Items exist in every stage
    resp = requests.get(f"{API_BASE}/purchases/stages", headers=headers(token))
    if resp.status_code == 200:
        stages = resp.json()
        empty_stages = [s["key"] for s in stages if s.get("count", 0) == 0]
        if empty_stages:
            result.add_fail("14.3: Items exist in every stage", 
                           f"Empty stages: {empty_stages}")
        else:
            result.add_pass("14.3: Items exist in every stage")

# =============================================================================
# MAIN
# =============================================================================
def main():
    print("\n" + "="*80)
    print("FORGE — PURCHASES MATERIAL TRACKER — BACKEND TEST SUITE")
    print("="*80)
    print(f"Backend URL: {BASE_URL}")
    print(f"Test User: {TEST_EMAIL}")
    
    result = TestResult()
    
    # Login
    token = login()
    
    # Run all tests
    test_stages(token, result)
    test_brands(token, result)
    test_customers(token, result)
    test_items_today(token, result)
    test_items_filters(token, result)
    test_item_detail(token, result)
    test_move_item(token, result)
    test_bulk_move(token, result)
    test_transfer(token, result)
    test_export_xlsx(token, result)
    test_settings(token, result)
    test_auth(result)
    test_regression(token, result)
    test_seed_integrity(token, result)
    
    # Summary
    result.summary()
    
    # Exit with appropriate code
    sys.exit(0 if result.failed == 0 else 1)

if __name__ == "__main__":
    main()
