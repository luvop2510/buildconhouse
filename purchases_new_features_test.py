"""
BuildCon House / Forge — Purchases Module New Features Test Suite

Tests ONLY the newly added/changed Purchases endpoints as per review request:
1. PARTIAL-QUANTITY SPLIT MOVE — POST /api/purchases/items/{item_id}/move with qty parameter
2. CUSTOMER PURCHASE WORKSPACE — GET /api/purchases/customers/{customer_id}/workspace
3. SUPPLIER PASSTHROUGH + product_id FILTER — GET /api/purchases/items with supplier fields and product_id filter
4. TRANSFER TO EXISTING CUSTOMER — POST /api/purchases/items/{item_id}/transfer

Test credentials: owner@forge.app / [legacy credential removed]
Backend URL: Uses REACT_APP_BACKEND_URL from frontend/.env (empty = same-origin)
"""
import os
import sys
import requests
import json
from typing import Optional, Dict, Any

# Backend URL configuration - read from frontend/.env
def get_backend_url():
    """Read REACT_APP_BACKEND_URL from frontend/.env"""
    env_path = "/app/frontend/.env"
    backend_url = ""
    if os.path.exists(env_path):
        with open(env_path, 'r') as f:
            for line in f:
                if line.startswith('REACT_APP_BACKEND_URL='):
                    backend_url = line.split('=', 1)[1].strip()
                    break
    
    # If empty or not set, use same-origin (empty string means /api routes work via ingress)
    if not backend_url:
        # For testing, we need the actual URL. Check if we're in the container
        # In container, backend is at localhost:8001
        backend_url = "http://localhost:8001"
    
    return backend_url.rstrip("/")

BASE_URL = get_backend_url()
API_BASE = f"{BASE_URL}/api"

# Test credentials from /app/memory/test_credentials.md
TEST_EMAIL = "owner@forge.app"
TEST_PASSWORD = os.environ["FORGE_TEST_OWNER_PASSWORD"]

class TestResult:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.failures = []
        self.test_data = {}  # Store data for use across tests
    
    def add_pass(self, test_name: str, details: Optional[str] = None):
        self.passed += 1
        print(f"✅ PASS: {test_name}")
        if details:
            print(f"   {details}")
    
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
            print(f"   Details: {json.dumps(details, indent=2)}")
    
    def summary(self):
        total = self.passed + self.failed
        print("\n" + "="*80)
        print(f"TEST SUMMARY: {self.passed}/{total} PASSED ({self.passed/total*100:.1f}% success rate)")
        print("="*80)
        if self.failures:
            print("\n❌ FAILED TESTS:")
            for f in self.failures:
                print(f"  • {f['test']}: {f['reason']}")
        else:
            print("\n🎉 ALL TESTS PASSED!")
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
    print(f"✅ Login successful")
    return token

def headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}

# =============================================================================
# SETUP: Find or create test data
# =============================================================================
def setup_test_data(token: str, result: TestResult):
    """Find or create a PO with items for testing"""
    print("\n" + "="*80)
    print("SETUP: Finding test data")
    print("="*80)
    
    # Get existing items
    resp = requests.get(f"{API_BASE}/purchases/items?view=stock&limit=100", headers=headers(token))
    if resp.status_code != 200:
        print(f"❌ Failed to get items: {resp.status_code}")
        return False
    
    data = resp.json()
    items = data.get("items", [])
    
    if not items:
        print("❌ No purchase items found. Need to create test data first.")
        return False
    
    # Find an item with qty >= 4 for split testing
    split_item = None
    for item in items:
        if item.get("qty", 0) >= 4:
            split_item = item
            break
    
    if not split_item:
        print("⚠️  No item with qty >= 4 found. Will use first item for other tests.")
        split_item = items[0]
    
    result.test_data["split_item"] = split_item
    result.test_data["all_items"] = items
    
    # Get customers for transfer testing
    resp = requests.get(f"{API_BASE}/customers", headers=headers(token))
    if resp.status_code == 200:
        customers = resp.json()
        if len(customers) >= 2:
            result.test_data["customers"] = customers[:2]
            print(f"✅ Found {len(customers)} customers for transfer testing")
        else:
            print("⚠️  Need at least 2 customers for transfer testing")
    
    print(f"✅ Setup complete: Found {len(items)} items")
    print(f"   Test item: {split_item.get('name')} (qty={split_item.get('qty')}, stage={split_item.get('stage')})")
    
    return True

# =============================================================================
# TEST 1: PARTIAL-QUANTITY SPLIT MOVE
# =============================================================================
def test_partial_split_move(token: str, result: TestResult):
    print("\n" + "="*80)
    print("TEST 1: PARTIAL-QUANTITY SPLIT MOVE — POST /api/purchases/items/{item_id}/move")
    print("="*80)
    
    item = result.test_data.get("split_item")
    if not item:
        result.add_fail("1.0: Setup", "No test item available")
        return
    
    item_id = item["item_id"]
    current_stage = item["stage"]
    current_qty = item["qty"]
    
    print(f"\nTest item: {item['name']}")
    print(f"  ID: {item_id}")
    print(f"  Current qty: {current_qty}")
    print(f"  Current stage: {current_stage}")
    
    # Determine target stage (different from current)
    all_stages = ["order_in_company", "company_billing", "in_box", "dispatched", "in_transit", "delivered"]
    target_stage = None
    for stage in all_stages:
        if stage != current_stage:
            target_stage = stage
            break
    
    if not target_stage:
        target_stage = "company_billing" if current_stage != "company_billing" else "in_box"
    
    # TEST 1a: FULL move (no qty param)
    print(f"\n--- Test 1a: FULL move to {target_stage} (no qty param) ---")
    resp = requests.post(
        f"{API_BASE}/purchases/items/{item_id}/move",
        headers=headers(token),
        json={"stage": target_stage, "note": "Test full move"}
    )
    
    if resp.status_code != 200:
        result.add_fail("1a: Full move", f"Got {resp.status_code}", {"body": resp.text})
    else:
        move_result = resp.json()
        print(f"Response: {json.dumps(move_result, indent=2)}")
        
        # Check response has no "split" key or split=false
        has_split = move_result.get("split", False)
        if has_split:
            result.add_fail("1a: Full move should not have split=true", 
                          f"Got split={has_split}", move_result)
        else:
            result.add_pass("1a: Full move - no split key or split=false")
        
        # Verify item was moved
        resp2 = requests.get(f"{API_BASE}/purchases/items/{item_id}", headers=headers(token))
        if resp2.status_code == 200:
            item_detail = resp2.json()
            new_stage = item_detail.get("stage")
            stage_history = item_detail.get("stage_history", [])
            
            if new_stage == target_stage:
                result.add_pass("1a: Item stage updated correctly", f"Stage is now {new_stage}")
            else:
                result.add_fail("1a: Item stage not updated", 
                              f"Expected {target_stage}, got {new_stage}")
            
            # Check stage_history has a "move" action
            if stage_history:
                last_event = stage_history[-1]
                if last_event.get("action") == "move":
                    result.add_pass("1a: Stage history has 'move' action")
                else:
                    result.add_fail("1a: Stage history action", 
                                  f"Expected 'move', got {last_event.get('action')}")
    
    # For remaining tests, we need a fresh item with qty >= 4
    # Find another item or skip if not available
    items = result.test_data.get("all_items", [])
    partial_test_item = None
    for it in items:
        if it["item_id"] != item_id and it.get("qty", 0) >= 4:
            partial_test_item = it
            break
    
    if not partial_test_item:
        print("\n⚠️  Skipping partial move tests - no item with qty >= 4 available")
        result.add_fail("1b-1d: Partial move tests", "No suitable item with qty >= 4 found")
        return
    
    # TEST 1b: PARTIAL move
    print(f"\n--- Test 1b: PARTIAL move (qty=2 of {partial_test_item['qty']}) ---")
    partial_item_id = partial_test_item["item_id"]
    partial_current_stage = partial_test_item["stage"]
    partial_current_qty = partial_test_item["qty"]
    
    # Pick a different stage
    partial_target_stage = None
    for stage in all_stages:
        if stage != partial_current_stage:
            partial_target_stage = stage
            break
    
    move_qty = 2
    expected_remaining = partial_current_qty - move_qty
    
    resp = requests.post(
        f"{API_BASE}/purchases/items/{partial_item_id}/move",
        headers=headers(token),
        json={"stage": partial_target_stage, "qty": move_qty, "note": "Test partial move"}
    )
    
    if resp.status_code != 200:
        result.add_fail("1b: Partial move", f"Got {resp.status_code}", {"body": resp.text})
    else:
        move_result = resp.json()
        print(f"Response: {json.dumps(move_result, indent=2)}")
        
        # Check response contains split=true, new_item_id, qty_moved, qty_remaining
        if not move_result.get("split"):
            result.add_fail("1b: Partial move should have split=true", 
                          "Missing or false split flag", move_result)
        else:
            result.add_pass("1b: Partial move has split=true")
        
        new_item_id = move_result.get("new_item_id")
        if not new_item_id:
            result.add_fail("1b: Partial move missing new_item_id", "", move_result)
        else:
            result.add_pass("1b: Partial move has new_item_id", f"New item: {new_item_id}")
        
        if move_result.get("qty_moved") == move_qty:
            result.add_pass("1b: qty_moved correct", f"qty_moved={move_qty}")
        else:
            result.add_fail("1b: qty_moved incorrect", 
                          f"Expected {move_qty}, got {move_result.get('qty_moved')}")
        
        if abs(move_result.get("qty_remaining", 0) - expected_remaining) < 0.01:
            result.add_pass("1b: qty_remaining correct", f"qty_remaining={expected_remaining}")
        else:
            result.add_fail("1b: qty_remaining incorrect", 
                          f"Expected {expected_remaining}, got {move_result.get('qty_remaining')}")
        
        # Verify original item
        resp2 = requests.get(f"{API_BASE}/purchases/items/{partial_item_id}", headers=headers(token))
        if resp2.status_code == 200:
            orig_item = resp2.json()
            
            # Qty should be reduced
            if abs(orig_item.get("qty", 0) - expected_remaining) < 0.01:
                result.add_pass("1b: Original item qty reduced", f"Now {expected_remaining}")
            else:
                result.add_fail("1b: Original item qty not reduced correctly", 
                              f"Expected {expected_remaining}, got {orig_item.get('qty')}")
            
            # Stage should be UNCHANGED
            if orig_item.get("stage") == partial_current_stage:
                result.add_pass("1b: Original item stage unchanged", f"Still {partial_current_stage}")
            else:
                result.add_fail("1b: Original item stage changed", 
                              f"Expected {partial_current_stage}, got {orig_item.get('stage')}")
            
            # Check stage_history has "split_out" action
            stage_history = orig_item.get("stage_history", [])
            if stage_history:
                last_event = stage_history[-1]
                if last_event.get("action") == "split_out":
                    result.add_pass("1b: Original item has 'split_out' action in history")
                else:
                    result.add_fail("1b: Original item stage_history action", 
                                  f"Expected 'split_out', got {last_event.get('action')}")
        
        # Verify new item
        if new_item_id:
            resp3 = requests.get(f"{API_BASE}/purchases/items/{new_item_id}", headers=headers(token))
            if resp3.status_code == 200:
                new_item = resp3.json()
                
                # Qty should be move_qty
                if abs(new_item.get("qty", 0) - move_qty) < 0.01:
                    result.add_pass("1b: New item qty correct", f"qty={move_qty}")
                else:
                    result.add_fail("1b: New item qty incorrect", 
                                  f"Expected {move_qty}, got {new_item.get('qty')}")
                
                # Stage should be target_stage
                if new_item.get("stage") == partial_target_stage:
                    result.add_pass("1b: New item stage correct", f"Stage={partial_target_stage}")
                else:
                    result.add_fail("1b: New item stage incorrect", 
                                  f"Expected {partial_target_stage}, got {new_item.get('stage')}")
                
                # Check stage_history has "split_in" action with split_from_item_id
                stage_history = new_item.get("stage_history", [])
                if stage_history:
                    last_event = stage_history[-1]
                    if last_event.get("action") == "split_in":
                        result.add_pass("1b: New item has 'split_in' action in history")
                        
                        # Check ref_item_id references original
                        if last_event.get("ref_item_id") == partial_item_id:
                            result.add_pass("1b: New item history references original item")
                        else:
                            result.add_fail("1b: New item history ref_item_id", 
                                          f"Expected {partial_item_id}, got {last_event.get('ref_item_id')}")
                    else:
                        result.add_fail("1b: New item stage_history action", 
                                      f"Expected 'split_in', got {last_event.get('action')}")
    
    # TEST 1c: INVALID qty
    print(f"\n--- Test 1c: INVALID qty (0, -1, > available) ---")
    
    # Test qty=0
    resp = requests.post(
        f"{API_BASE}/purchases/items/{partial_item_id}/move",
        headers=headers(token),
        json={"stage": partial_target_stage, "qty": 0}
    )
    if resp.status_code in [400, 422]:  # 422 is Pydantic validation error
        result.add_pass("1c: qty=0 rejected with 400/422")
    else:
        result.add_fail("1c: qty=0 should return 400/422", f"Got {resp.status_code}")
    
    # Test qty=-1
    resp = requests.post(
        f"{API_BASE}/purchases/items/{partial_item_id}/move",
        headers=headers(token),
        json={"stage": partial_target_stage, "qty": -1}
    )
    if resp.status_code in [400, 422]:  # 422 is Pydantic validation error
        result.add_pass("1c: qty=-1 rejected with 400/422")
    else:
        result.add_fail("1c: qty=-1 should return 400/422", f"Got {resp.status_code}")
    
    # Test qty > available
    # Get current qty first
    resp = requests.get(f"{API_BASE}/purchases/items/{partial_item_id}", headers=headers(token))
    if resp.status_code == 200:
        current_item = resp.json()
        current_qty_now = current_item.get("qty", 0)
        
        resp = requests.post(
            f"{API_BASE}/purchases/items/{partial_item_id}/move",
            headers=headers(token),
            json={"stage": partial_target_stage, "qty": current_qty_now + 10}
        )
        if resp.status_code == 400:
            result.add_pass("1c: qty > available rejected with 400", 
                          f"Tried to move {current_qty_now + 10} when only {current_qty_now} available")
        else:
            result.add_fail("1c: qty > available should return 400", f"Got {resp.status_code}")
    
    # TEST 1d: Moving to SAME stage with no qty (should return no_change=true)
    print(f"\n--- Test 1d: Move to SAME stage (should return no_change=true) ---")
    
    # Get current stage
    resp = requests.get(f"{API_BASE}/purchases/items/{partial_item_id}", headers=headers(token))
    if resp.status_code == 200:
        current_item = resp.json()
        same_stage = current_item.get("stage")
        
        resp = requests.post(
            f"{API_BASE}/purchases/items/{partial_item_id}/move",
            headers=headers(token),
            json={"stage": same_stage}
        )
        
        if resp.status_code == 200:
            move_result = resp.json()
            if move_result.get("no_change"):
                result.add_pass("1d: Same stage move returns no_change=true")
            else:
                result.add_fail("1d: Same stage move should return no_change=true", 
                              "Missing no_change flag", move_result)
            
            # Verify no new stage_history entry was added
            # (We'd need to compare before/after history length, but for simplicity we'll trust the no_change flag)
        else:
            result.add_fail("1d: Same stage move", f"Got {resp.status_code}", {"body": resp.text})

# =============================================================================
# TEST 2: CUSTOMER PURCHASE WORKSPACE
# =============================================================================
def test_customer_workspace(token: str, result: TestResult):
    print("\n" + "="*80)
    print("TEST 2: CUSTOMER PURCHASE WORKSPACE — GET /api/purchases/customers/{customer_id}/workspace")
    print("="*80)
    
    # Get a customer with purchase history
    resp = requests.get(f"{API_BASE}/purchases/customers", headers=headers(token))
    if resp.status_code != 200:
        result.add_fail("2.0: Get customers", f"Got {resp.status_code}")
        return
    
    customers = resp.json()
    if not customers:
        result.add_fail("2.0: No customers found", "Need at least one customer with purchases")
        return
    
    # Pick first customer with count > 0
    test_customer = None
    for c in customers:
        if c.get("count", 0) > 0:
            test_customer = c
            break
    
    if not test_customer:
        test_customer = customers[0]
    
    customer_id = test_customer["id"]
    print(f"\nTest customer: {test_customer['name']} (ID: {customer_id})")
    
    # TEST 2a: Valid customer_id
    print(f"\n--- Test 2a: Valid customer workspace ---")
    resp = requests.get(f"{API_BASE}/purchases/customers/{customer_id}/workspace", 
                       headers=headers(token))
    
    if resp.status_code != 200:
        result.add_fail("2a: Get workspace", f"Got {resp.status_code}", {"body": resp.text})
        return
    
    workspace = resp.json()
    print(f"Response keys: {list(workspace.keys())}")
    
    # Check top-level keys
    required_keys = ["customer", "summary", "products", "brands", "stages", 
                     "purchase_orders", "outstanding_items", "recent_activity", "expected_delivery"]
    
    missing_keys = [k for k in required_keys if k not in workspace]
    if missing_keys:
        result.add_fail("2a: Missing top-level keys", f"Missing: {missing_keys}")
    else:
        result.add_pass("2a: All top-level keys present", f"Keys: {required_keys}")
    
    # Check summary fields
    summary = workspace.get("summary", {})
    summary_fields = ["total_items", "total_value", "outstanding_value", "outstanding_count", 
                     "open_pos", "blocked_count", "delivered_count"]
    
    missing_summary = [f for f in summary_fields if f not in summary]
    if missing_summary:
        result.add_fail("2a: Missing summary fields", f"Missing: {missing_summary}")
    else:
        result.add_pass("2a: All summary fields present")
        
        # Check all are numbers
        all_numbers = all(isinstance(summary.get(f), (int, float)) for f in summary_fields)
        if all_numbers:
            result.add_pass("2a: All summary fields are numbers")
        else:
            result.add_fail("2a: Summary fields should be numbers", 
                          f"Summary: {summary}")
    
    # Check stages is a list covering all 6 known stages
    stages = workspace.get("stages", [])
    if not isinstance(stages, list):
        result.add_fail("2a: stages should be a list", f"Got {type(stages)}")
    else:
        stage_keys = [s.get("key") for s in stages]
        expected_stages = ["order_in_company", "company_billing", "in_box", 
                          "dispatched", "in_transit", "delivered"]
        
        if set(stage_keys) == set(expected_stages):
            result.add_pass("2a: All 6 stages present", f"Stages: {stage_keys}")
        else:
            missing = set(expected_stages) - set(stage_keys)
            result.add_fail("2a: Missing stages", f"Missing: {missing}")
        
        # Check each stage has count (even if 0)
        all_have_count = all("count" in s for s in stages)
        if all_have_count:
            result.add_pass("2a: All stages have count field")
        else:
            result.add_fail("2a: Some stages missing count field")
    
    # TEST 2b: Non-existent customer_id
    print(f"\n--- Test 2b: Non-existent customer (should return 404) ---")
    fake_id = "00000000-0000-0000-0000-000000000000"
    resp = requests.get(f"{API_BASE}/purchases/customers/{fake_id}/workspace", 
                       headers=headers(token))
    
    if resp.status_code == 404:
        result.add_pass("2b: Non-existent customer returns 404")
    else:
        result.add_fail("2b: Non-existent customer should return 404", 
                      f"Got {resp.status_code}")

# =============================================================================
# TEST 3: SUPPLIER PASSTHROUGH + product_id FILTER
# =============================================================================
def test_supplier_and_product_filter(token: str, result: TestResult):
    print("\n" + "="*80)
    print("TEST 3: SUPPLIER PASSTHROUGH + product_id FILTER — GET /api/purchases/items")
    print("="*80)
    
    # TEST 3a: Check supplier_id and supplier_name in response
    print(f"\n--- Test 3a: Supplier fields present ---")
    resp = requests.get(f"{API_BASE}/purchases/items?view=stock&limit=50", 
                       headers=headers(token))
    
    if resp.status_code != 200:
        result.add_fail("3a: Get items", f"Got {resp.status_code}")
        return
    
    data = resp.json()
    items = data.get("items", [])
    
    if not items:
        result.add_fail("3a: No items found", "Need items to test supplier fields")
        return
    
    # Check each item has supplier_id and supplier_name keys (values may be null)
    all_have_supplier_id = all("supplier_id" in item for item in items)
    all_have_supplier_name = all("supplier_name" in item for item in items)
    
    if all_have_supplier_id:
        result.add_pass("3a: All items have supplier_id key", 
                      f"Checked {len(items)} items")
    else:
        missing_count = sum(1 for item in items if "supplier_id" not in item)
        result.add_fail("3a: Some items missing supplier_id", 
                      f"{missing_count}/{len(items)} items missing supplier_id")
    
    if all_have_supplier_name:
        result.add_pass("3a: All items have supplier_name key", 
                      f"Checked {len(items)} items")
    else:
        missing_count = sum(1 for item in items if "supplier_name" not in item)
        result.add_fail("3a: Some items missing supplier_name", 
                      f"{missing_count}/{len(items)} items missing supplier_name")
    
    # TEST 3b: product_id filter
    print(f"\n--- Test 3b: product_id filter ---")
    
    # Pick a product_id from the items
    test_product_id = None
    for item in items:
        if item.get("product_id"):
            test_product_id = item["product_id"]
            break
    
    if not test_product_id:
        result.add_fail("3b: No product_id found in items", "Cannot test product_id filter")
        return
    
    print(f"Testing with product_id: {test_product_id}")
    
    resp = requests.get(f"{API_BASE}/purchases/items?product_id={test_product_id}&limit=100", 
                       headers=headers(token))
    
    if resp.status_code != 200:
        result.add_fail("3b: Get items with product_id filter", f"Got {resp.status_code}")
        return
    
    filtered_data = resp.json()
    filtered_items = filtered_data.get("items", [])
    
    if not filtered_items:
        result.add_fail("3b: product_id filter returned no items", 
                      f"Expected items with product_id={test_product_id}")
        return
    
    # Check all returned items have the same product_id
    all_match = all(item.get("product_id") == test_product_id for item in filtered_items)
    
    if all_match:
        result.add_pass("3b: product_id filter works correctly", 
                      f"All {len(filtered_items)} items have product_id={test_product_id}")
    else:
        mismatched = [item for item in filtered_items if item.get("product_id") != test_product_id]
        result.add_fail("3b: product_id filter returned wrong items", 
                      f"{len(mismatched)} items don't match filter")
    
    # Verify count > 0
    if len(filtered_items) > 0:
        result.add_pass("3b: product_id filter returned items", f"Count: {len(filtered_items)}")
    else:
        result.add_fail("3b: product_id filter returned 0 items", 
                      "Expected at least 1 item")

# =============================================================================
# TEST 4: TRANSFER TO EXISTING CUSTOMER
# =============================================================================
def test_transfer_to_customer(token: str, result: TestResult):
    print("\n" + "="*80)
    print("TEST 4: TRANSFER TO EXISTING CUSTOMER — POST /api/purchases/items/{item_id}/transfer")
    print("="*80)
    
    # Get customers
    resp = requests.get(f"{API_BASE}/customers", headers=headers(token))
    if resp.status_code != 200:
        result.add_fail("4.0: Get customers", f"Got {resp.status_code}")
        return
    
    customers = resp.json()
    if len(customers) < 2:
        result.add_fail("4.0: Need at least 2 customers", f"Only found {len(customers)}")
        return
    
    # Get items
    resp = requests.get(f"{API_BASE}/purchases/items?view=stock&limit=100", 
                       headers=headers(token))
    if resp.status_code != 200:
        result.add_fail("4.0: Get items", f"Got {resp.status_code}")
        return
    
    data = resp.json()
    items = data.get("items", [])
    
    if not items:
        result.add_fail("4.0: No items found", "Need items to test transfer")
        return
    
    # Find an item with qty >= 2 that's not in delivered stage
    transfer_item = None
    for item in items:
        if item.get("qty", 0) >= 2 and item.get("stage") != "delivered":
            transfer_item = item
            break
    
    if not transfer_item:
        # Use first item even if qty < 2
        transfer_item = items[0]
    
    item_id = transfer_item["item_id"]
    source_customer_id = transfer_item["customer_id"]
    current_qty = transfer_item["qty"]
    
    # Find a different customer
    dest_customer = None
    for c in customers:
        if c["id"] != source_customer_id:
            dest_customer = c
            break
    
    if not dest_customer:
        result.add_fail("4.0: Cannot find different customer", "All items belong to same customer")
        return
    
    dest_customer_id = dest_customer["id"]
    
    print(f"\nTransfer item: {transfer_item['name']}")
    print(f"  ID: {item_id}")
    print(f"  Current qty: {current_qty}")
    print(f"  Source customer: {transfer_item['customer_name']}")
    print(f"  Destination customer: {dest_customer.get('name') or dest_customer.get('company')}")
    
    # Determine transfer qty (half of current qty, or 1 if qty < 2)
    transfer_qty = max(1, int(current_qty / 2))
    
    print(f"  Transfer qty: {transfer_qty}")
    
    # TEST 4: Transfer
    resp = requests.post(
        f"{API_BASE}/purchases/items/{item_id}/transfer",
        headers=headers(token),
        json={
            "new_customer_id": dest_customer_id,
            "qty": transfer_qty,
            "reason": "Test transfer"
        }
    )
    
    if resp.status_code != 200:
        result.add_fail("4: Transfer item", f"Got {resp.status_code}", {"body": resp.text})
        return
    
    transfer_result = resp.json()
    print(f"Transfer response: {json.dumps(transfer_result, indent=2)}")
    
    # Check response has "destination" object with po_number and customer_name
    destination = transfer_result.get("destination")
    if not destination:
        result.add_fail("4: Transfer response missing 'destination'", "", transfer_result)
    else:
        if "po_number" in destination:
            result.add_pass("4: Transfer response has destination.po_number", 
                          f"PO: {destination['po_number']}")
        else:
            result.add_fail("4: Transfer response missing destination.po_number")
        
        if "customer_name" in destination:
            result.add_pass("4: Transfer response has destination.customer_name", 
                          f"Customer: {destination['customer_name']}")
        else:
            result.add_fail("4: Transfer response missing destination.customer_name")
    
    # Verify destination customer now has a new PO
    resp = requests.get(f"{API_BASE}/purchase-orders?customer_id={dest_customer_id}", 
                       headers=headers(token))
    
    if resp.status_code == 200:
        dest_pos = resp.json()
        
        # Check if the new PO is in the list
        new_po_number = destination.get("po_number") if destination else None
        if new_po_number:
            found_po = any(po.get("number") == new_po_number for po in dest_pos)
            if found_po:
                result.add_pass("4: New PO found in destination customer's PO list", 
                              f"PO: {new_po_number}")
            else:
                result.add_fail("4: New PO not found in destination customer's PO list", 
                              f"Expected {new_po_number}")
    
    # Verify original item's qty decreased
    resp = requests.get(f"{API_BASE}/purchases/items/{item_id}", headers=headers(token))
    if resp.status_code == 200:
        updated_item = resp.json()
        new_qty = updated_item.get("qty", 0)
        expected_qty = current_qty - transfer_qty
        
        if abs(new_qty - expected_qty) < 0.01:
            result.add_pass("4: Original item qty decreased correctly", 
                          f"Was {current_qty}, now {new_qty}")
        else:
            result.add_fail("4: Original item qty not decreased correctly", 
                          f"Expected {expected_qty}, got {new_qty}")
    elif resp.status_code == 404:
        # Item might be fully consumed if transfer_qty == current_qty
        if transfer_qty >= current_qty - 0.01:
            result.add_pass("4: Original item removed (full qty transferred)")
        else:
            result.add_fail("4: Original item should still exist", 
                          f"Transferred {transfer_qty} of {current_qty}")

# =============================================================================
# MAIN
# =============================================================================
def main():
    print("="*80)
    print("BuildCon House / Forge — Purchases Module New Features Test Suite")
    print("="*80)
    print(f"Backend URL: {BASE_URL}")
    print(f"API Base: {API_BASE}")
    
    result = TestResult()
    
    # Login
    token = login()
    
    # Setup test data
    if not setup_test_data(token, result):
        print("\n❌ Setup failed. Cannot proceed with tests.")
        sys.exit(1)
    
    # Run tests
    test_partial_split_move(token, result)
    test_customer_workspace(token, result)
    test_supplier_and_product_filter(token, result)
    test_transfer_to_customer(token, result)
    
    # Summary
    result.summary()
    
    # Exit with appropriate code
    sys.exit(0 if result.failed == 0 else 1)

if __name__ == "__main__":
    main()
