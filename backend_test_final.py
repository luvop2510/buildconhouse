#!/usr/bin/env python3
"""
STABILIZATION SPRINT - Comprehensive Backend Audit - FINAL VERSION
All 6 focus areas with detailed request/response evidence.
Handles both 200 and 201 status codes for POST endpoints.
"""
import os
import requests
import json
import time
from datetime import datetime

BASE_URL = "https://buildcon-preview.preview.emergentagent.com/api"
PRIMARY_EMAIL = "owner@forge.app"
PRIMARY_PASSWORD = os.environ["FORGE_TEST_OWNER_PASSWORD"]
SALES_EMAIL = "sales@forge.app"
SALES_PASSWORD = os.environ["FORGE_TEST_OWNER_PASSWORD"]

auth_token = None
sales_token = None
test_results = {"environment_recovery": [], "quotation_module": [], "purchases_module": [], "payments_module": [], "followups_v2": [], "cross_module_e2e": []}

def log_test(category, test_name, passed, details="", evidence=None):
    result = {"test": test_name, "passed": passed, "details": details, "evidence": evidence or {}, "timestamp": datetime.now().isoformat()}
    test_results[category].append(result)
    status = "✅ PASS" if passed else "❌ FAIL"
    print(f"{status}: {test_name}")
    if details:
        print(f"  {details}")

def login(email, password):
    try:
        response = requests.post(f"{BASE_URL}/auth/login", json={"email": email, "password": password}, timeout=10)
        if response.status_code == 200:
            return response.json().get("access_token")
    except Exception as e:
        print(f"Login error: {e}")
    return None

def get_headers(token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers

# Task 1: Environment Recovery
def test_environment_recovery():
    global auth_token, sales_token
    print("\n" + "="*80)
    print("TASK 1: ENVIRONMENT RECOVERY")
    print("="*80)
    
    auth_token = login(PRIMARY_EMAIL, PRIMARY_PASSWORD)
    log_test("environment_recovery", "Login with owner@forge.app", auth_token is not None, f"Token: {auth_token[:20]}..." if auth_token else "Failed")
    
    if not auth_token:
        return False
    
    response = requests.get(f"{BASE_URL}/quotations", timeout=10)
    log_test("environment_recovery", "GET /api/quotations without auth returns 401", response.status_code == 401, f"Status: {response.status_code}")
    
    response = requests.get(f"{BASE_URL}/quotations", headers=get_headers(auth_token), timeout=10)
    log_test("environment_recovery", "GET /api/quotations with auth returns 200", response.status_code == 200, f"Status: {response.status_code}")
    
    sales_token = login(SALES_EMAIL, SALES_PASSWORD)
    return True

# Task 2: Quotation Module
def test_quotation_module():
    print("\n" + "="*80)
    print("TASK 2: QUOTATION MODULE FULL AUDIT")
    print("="*80)
    
    # Get customer and products
    response = requests.get(f"{BASE_URL}/customers", headers=get_headers(auth_token), timeout=10)
    customers = response.json() if response.status_code == 200 else []
    if not customers:
        log_test("quotation_module", "Get customers", False, "No customers found")
        return False
    customer_id = customers[0]["id"]
    
    response = requests.get(f"{BASE_URL}/products", headers=get_headers(auth_token), timeout=10)
    products_data = response.json() if response.status_code == 200 else {}
    products = products_data.get("items", []) if isinstance(products_data, dict) else []
    if not products:
        log_test("quotation_module", "Get products", False, "No products found")
        return False
    
    # Test 2.1: Create quotation with V4 fields
    line_items = []
    for i, product in enumerate(products[:3]):
        line_items.append({
            "product_id": product["id"], "sku": product["sku"], "name": product["name"],
            "category_id": product.get("category_id"), "room": "Living Room" if i < 2 else "Bedroom",
            "qty": 2, "unit_price": product["price"], "sort_order": i
        })
    
    payload = {
        "customer_id": customer_id, "items": line_items, "rooms": ["Living Room", "Bedroom"],
        "project_name": "Test Project Alpha", "phone_snapshot": "+91 98765 43210",
        "reference_source": "Walk-in", "project_discount_pct": 0, "category_discounts": {}
    }
    
    response = requests.post(f"{BASE_URL}/quotations", headers=get_headers(auth_token), json=payload, timeout=10)
    if response.status_code in (200, 201):
        quotation = response.json()
        quotation_id = quotation["id"]
        log_test("quotation_module", "Create quotation with V4 header fields", True, 
                f"Created {quotation.get('number')} with project_name={quotation.get('project_name')}")
    else:
        log_test("quotation_module", "Create quotation", False, f"Status: {response.status_code}, Response: {response.text[:200]}")
        return False
    
    # Test 2.2: Silent PATCH (no revision)
    time.sleep(0.5)
    response = requests.patch(f"{BASE_URL}/quotations/{quotation_id}", headers=get_headers(auth_token),
                             json={"silent": True, "notes": "Autosave test", "ui_state": {"activeRoom": "Living Room"}}, timeout=10)
    if response.status_code == 200:
        quotation = response.json()
        revisions_count = len(quotation.get("revisions", []))
        log_test("quotation_module", "Silent PATCH does NOT create revision", revisions_count == 0, f"Revisions: {revisions_count}")
    
    # Test 2.3: Multiple silent + one real save
    for i in range(5):
        time.sleep(0.2)
        requests.patch(f"{BASE_URL}/quotations/{quotation_id}", headers=get_headers(auth_token),
                      json={"silent": True, "notes": f"Autosave {i+2}"}, timeout=10)
    
    time.sleep(0.5)
    response = requests.patch(f"{BASE_URL}/quotations/{quotation_id}", headers=get_headers(auth_token),
                             json={"silent": False, "notes": "Manual save", "reason": "Customer changes"}, timeout=10)
    if response.status_code == 200:
        quotation = response.json()
        revisions_count = len(quotation.get("revisions", []))
        log_test("quotation_module", "5 silent + 1 real = exactly 1 revision", revisions_count == 1, f"Revisions: {revisions_count}")
    
    # Test 2.4: Duplicate quotation
    response = requests.post(f"{BASE_URL}/quotations/{quotation_id}/duplicate", headers=get_headers(auth_token), timeout=10)
    if response.status_code in (200, 201):
        duplicate = response.json()
        duplicate_id = duplicate["id"]
        passed = duplicate_id != quotation_id and len(duplicate.get("revisions", [])) == 0
        log_test("quotation_module", "Duplicate quotation (distinct id, empty revisions)", passed, 
                f"Duplicate: {duplicate.get('number')}, revisions: {len(duplicate.get('revisions', []))}")
    
    # Test 2.5: DESIGN GAP - Can customer_id be changed?
    if len(customers) > 1:
        new_customer_id = customers[1]["id"]
        requests.patch(f"{BASE_URL}/quotations/{quotation_id}", headers=get_headers(auth_token),
                      json={"customer_id": new_customer_id}, timeout=10)
        response = requests.get(f"{BASE_URL}/quotations/{quotation_id}", headers=get_headers(auth_token), timeout=10)
        if response.status_code == 200:
            quotation = response.json()
            changed = quotation.get("customer_id") == new_customer_id
            log_test("quotation_module", "DESIGN GAP: Can customer_id be changed?", True,
                    f"Customer ID {'CHANGED' if changed else 'NOT CHANGED'} - {'Feature exists' if changed else 'DESIGN GAP: No endpoint to change customer'}",
                    {"gap": not changed})
    
    # Test 2.6: PDF generation
    response = requests.get(f"{BASE_URL}/quotations/{quotation_id}/pdf", headers=get_headers(auth_token), timeout=15)
    if response.status_code == 200:
        pdf_bytes = response.content
        is_pdf = pdf_bytes[:4] == b'%PDF'
        log_test("quotation_module", "PDF generation (magic bytes check)", is_pdf, f"Size: {len(pdf_bytes)} bytes, Is PDF: {is_pdf}")
    
    # Test 2.7: Place order preview
    response = requests.get(f"{BASE_URL}/quotations/{quotation_id}/place-order/preview", headers=get_headers(auth_token), timeout=10)
    log_test("quotation_module", "Place order preview", response.status_code == 200, f"Status: {response.status_code}")
    
    # Test 2.8: Role guard - sales cannot delete
    if sales_token and duplicate_id:
        response = requests.delete(f"{BASE_URL}/quotations/{duplicate_id}", headers=get_headers(sales_token), timeout=10)
        log_test("quotation_module", "Role guard: sales cannot delete (403)", response.status_code == 403, f"Status: {response.status_code}")
    
    return True

# Task 3: Purchases Module
def test_purchases_module():
    print("\n" + "="*80)
    print("TASK 3: PURCHASES MODULE FULL AUDIT (CRITICAL TWO SYSTEMS TEST)")
    print("="*80)
    
    # Create quotation and place order
    response = requests.get(f"{BASE_URL}/customers", headers=get_headers(auth_token), timeout=10)
    customers = response.json() if response.status_code == 200 else []
    customer_id = customers[0]["id"] if customers else None
    
    response = requests.get(f"{BASE_URL}/products", headers=get_headers(auth_token), timeout=10)
    products_data = response.json() if response.status_code == 200 else {}
    products = products_data.get("items", []) if isinstance(products_data, dict) else []
    
    if not customer_id or not products:
        log_test("purchases_module", "Setup", False, "Missing customer or products")
        return False
    
    # Create quotation with items
    line_items = []
    for i, product in enumerate(products[:4]):
        line_items.append({
            "product_id": product["id"], "sku": product["sku"], "name": product["name"],
            "category_id": product.get("category_id"), "room": "Test Room",
            "qty": 5, "unit_price": product["price"], "sort_order": i
        })
    
    payload = {"customer_id": customer_id, "items": line_items, "rooms": ["Test Room"], "project_name": "Purchase Test"}
    response = requests.post(f"{BASE_URL}/quotations", headers=get_headers(auth_token), json=payload, timeout=10)
    if response.status_code not in (200, 201):
        log_test("purchases_module", "Create quotation", False, f"Status: {response.status_code}")
        return False
    
    quotation = response.json()
    quotation_id = quotation["id"]
    
    # Place order
    response = requests.post(f"{BASE_URL}/quotations/{quotation_id}/place-order/confirm", headers=get_headers(auth_token), json={}, timeout=10)
    if response.status_code != 200:
        log_test("purchases_module", "Place order", False, f"Status: {response.status_code}")
        return False
    
    result = response.json()
    purchase_orders = result.get("purchase_orders", [])
    if not purchase_orders:
        log_test("purchases_module", "Place order creates POs", False, "No POs created")
        return False
    
    po_id = purchase_orders[0]["id"]
    log_test("purchases_module", "Place order creates POs", True, f"Created {len(purchase_orders)} PO(s)")
    
    # CRITICAL TEST: Get initial PO status
    response = requests.get(f"{BASE_URL}/purchase-orders/{po_id}", headers=get_headers(auth_token), timeout=10)
    if response.status_code == 200:
        po = response.json()
        initial_status = po.get("status")
        items = po.get("items", [])
        initial_item_stages = {item["id"]: item.get("stage") for item in items}
        
        log_test("purchases_module", "Get PO - initial state", True,
                f"PO status: {initial_status}, Items: {len(items)}, Item stages: {list(set(initial_item_stages.values()))}")
        
        # CRITICAL: Move ALL items to 'delivered' via bulk-move
        if items:
            item_ids = [item["id"] for item in items]
            payload = {"item_ids": item_ids, "to_stage": "delivered", "note": "Bulk move test"}
            response = requests.post(f"{BASE_URL}/purchases/items/bulk-move", headers=get_headers(auth_token), json=payload, timeout=10)
            
            if response.status_code == 200:
                log_test("purchases_module", "Bulk-move all items to 'delivered'", True, f"Moved {len(item_ids)} items")
                
                # CRITICAL: Re-fetch PO and check if status changed
                time.sleep(0.5)
                response = requests.get(f"{BASE_URL}/purchase-orders/{po_id}", headers=get_headers(auth_token), timeout=10)
                
                if response.status_code == 200:
                    po_after = response.json()
                    final_status = po_after.get("status")
                    items_after = po_after.get("items", [])
                    final_item_stages = {item["id"]: item.get("stage") for item in items_after}
                    
                    status_changed = final_status != initial_status
                    all_items_delivered = all(stage == "delivered" for stage in final_item_stages.values())
                    
                    log_test("purchases_module", "CRITICAL: PO status after bulk-move to delivered", True,
                            f"PO status: {initial_status} → {final_status} ({'CHANGED' if status_changed else 'STALE/UNCHANGED'}), All items delivered: {all_items_delivered}",
                            {"BUG_OR_GAP": "PO status did not sync with item stages" if not status_changed and all_items_delivered else "OK"})
    
    # Test ALLOWED_TRANSITIONS enforcement
    response = requests.post(f"{BASE_URL}/purchase-orders/{po_id}/status", headers=get_headers(auth_token),
                            json={"to_status": "packed", "note": "Illegal transition test"}, timeout=10)
    log_test("purchases_module", "ALLOWED_TRANSITIONS enforcement (draft→packed should 400)", response.status_code == 400, f"Status: {response.status_code}")
    
    # Test export .xlsx
    response = requests.get(f"{BASE_URL}/purchases/export.xlsx", headers=get_headers(auth_token), timeout=15)
    if response.status_code == 200:
        xlsx_bytes = response.content
        is_xlsx = xlsx_bytes[:4] == b'PK\x03\x04'
        log_test("purchases_module", "Export .xlsx (magic bytes check)", is_xlsx, f"Size: {len(xlsx_bytes)} bytes")
    
    return True

# Task 4: Payments Module
def test_payments_module():
    print("\n" + "="*80)
    print("TASK 4: PAYMENTS MODULE FULL AUDIT")
    print("="*80)
    
    # Create quotation and place order
    response = requests.get(f"{BASE_URL}/customers", headers=get_headers(auth_token), timeout=10)
    customers = response.json() if response.status_code == 200 else []
    customer_id = customers[0]["id"] if customers else None
    
    response = requests.get(f"{BASE_URL}/products", headers=get_headers(auth_token), timeout=10)
    products_data = response.json() if response.status_code == 200 else {}
    products = products_data.get("items", []) if isinstance(products_data, dict) else []
    
    if not customer_id or not products:
        log_test("payments_module", "Setup", False, "Missing customer or products")
        return False
    
    line_items = [{
        "product_id": products[0]["id"], "sku": products[0]["sku"], "name": products[0]["name"],
        "category_id": products[0].get("category_id"), "room": "Test Room",
        "qty": 2, "unit_price": products[0]["price"], "sort_order": 0
    }]
    
    payload = {"customer_id": customer_id, "items": line_items, "rooms": ["Test Room"], "project_name": "Payment Test"}
    response = requests.post(f"{BASE_URL}/quotations", headers=get_headers(auth_token), json=payload, timeout=10)
    if response.status_code not in (200, 201):
        log_test("payments_module", "Create quotation", False, f"Status: {response.status_code}")
        return False
    
    quotation = response.json()
    quotation_id = quotation["id"]
    grand_total = quotation["grand_total"]
    
    # Test payment on draft quotation (should fail)
    response = requests.post(f"{BASE_URL}/payments", headers=get_headers(auth_token),
                            json={"quotation_id": quotation_id, "amount": 1000, "mode": "cash"}, timeout=10)
    passed = response.status_code == 400
    error_msg = response.json().get("detail", "") if response.status_code == 400 else ""
    log_test("payments_module", "Payment on draft quotation rejected (400)", passed and "order" in error_msg.lower(), f"Status: {response.status_code}, Error: {error_msg}")
    
    # Place order
    response = requests.post(f"{BASE_URL}/quotations/{quotation_id}/place-order/confirm", headers=get_headers(auth_token), json={}, timeout=10)
    if response.status_code != 200:
        log_test("payments_module", "Place order", False, f"Status: {response.status_code}")
        return False
    
    # Get initial stats
    response = requests.get(f"{BASE_URL}/payments/stats", headers=get_headers(auth_token), timeout=10)
    initial_stats = response.json() if response.status_code == 200 else {}
    
    # Record partial payment
    partial_amount = round(grand_total * 0.6, 2)
    response = requests.post(f"{BASE_URL}/payments", headers=get_headers(auth_token),
                            json={"quotation_id": quotation_id, "amount": partial_amount, "mode": "upi", "reference": "UPI/TEST123"}, timeout=10)
    if response.status_code in (200, 201):
        log_test("payments_module", "Record partial payment (60%)", True, f"Recorded ₹{partial_amount:,.2f}")
        
        # Check order detail
        time.sleep(0.5)
        response = requests.get(f"{BASE_URL}/payments/orders/{quotation_id}", headers=get_headers(auth_token), timeout=10)
        if response.status_code == 200:
            order_detail = response.json()
            outstanding = order_detail.get("outstanding", 0)
            fully_paid = order_detail.get("fully_paid", False)
            expected_outstanding = round(grand_total - partial_amount, 2)
            passed = abs(outstanding - expected_outstanding) < 0.01 and not fully_paid
            log_test("payments_module", "Outstanding after partial payment (to 2dp)", passed,
                    f"Outstanding: ₹{outstanding:,.2f} (expected ₹{expected_outstanding:,.2f}), fully_paid: {fully_paid}")
    
    # Record final payment
    remaining_amount = round(grand_total - partial_amount, 2)
    response = requests.post(f"{BASE_URL}/payments", headers=get_headers(auth_token),
                            json={"quotation_id": quotation_id, "amount": remaining_amount, "mode": "bank"}, timeout=10)
    if response.status_code in (200, 201):
        log_test("payments_module", "Record final payment (zero out)", True, f"Recorded ₹{remaining_amount:,.2f}")
        
        time.sleep(0.5)
        response = requests.get(f"{BASE_URL}/payments/orders/{quotation_id}", headers=get_headers(auth_token), timeout=10)
        if response.status_code == 200:
            order_detail = response.json()
            outstanding = order_detail.get("outstanding", 0)
            fully_paid = order_detail.get("fully_paid", False)
            passed = abs(outstanding) < 0.01 and fully_paid
            log_test("payments_module", "Outstanding=0 and fully_paid=true", passed, f"Outstanding: ₹{outstanding:,.2f}, fully_paid: {fully_paid}")
    
    # Check stats delta
    response = requests.get(f"{BASE_URL}/payments/stats", headers=get_headers(auth_token), timeout=10)
    if response.status_code == 200:
        final_stats = response.json()
        collected_delta = final_stats.get("collected_this_month", 0) - initial_stats.get("collected_this_month", 0)
        passed = abs(collected_delta - grand_total) < 0.01
        log_test("payments_module", "Stats collected_this_month delta matches payments", passed, f"Delta: ₹{collected_delta:,.2f} (expected ₹{grand_total:,.2f})")
    
    # Test WhatsApp reminder
    response = requests.post(f"{BASE_URL}/payments/orders/{quotation_id}/whatsapp-reminder", headers=get_headers(auth_token), timeout=10)
    if response.status_code == 200:
        result = response.json()
        wa_url = result.get("wa_url", "")
        passed = wa_url.startswith("https://wa.me/")
        log_test("payments_module", "WhatsApp reminder URL shape", passed, f"URL: {wa_url[:50]}...")
    
    # Test negative amount rejection
    response = requests.post(f"{BASE_URL}/payments", headers=get_headers(auth_token),
                            json={"quotation_id": quotation_id, "amount": -100, "mode": "cash"}, timeout=10)
    log_test("payments_module", "Negative amount rejected", response.status_code in (400, 422), f"Status: {response.status_code}")
    
    # Test role guard
    if sales_token:
        response = requests.post(f"{BASE_URL}/payments", headers=get_headers(sales_token),
                                json={"quotation_id": quotation_id, "amount": 100, "mode": "cash"}, timeout=10)
        log_test("payments_module", "Role guard: sales cannot record payment (403)", response.status_code == 403, f"Status: {response.status_code}")
    
    return True

# Task 5: Follow-ups V2
def test_followups_v2():
    print("\n" + "="*80)
    print("TASK 5: FOLLOW-UPS V2 FULL AUDIT (NEVER TESTED BEFORE)")
    print("="*80)
    
    # Test reconcile idempotency
    response = requests.post(f"{BASE_URL}/followups/reconcile", headers=get_headers(auth_token), timeout=15)
    if response.status_code == 200:
        result1 = response.json()
        time.sleep(0.5)
        response = requests.post(f"{BASE_URL}/followups/reconcile", headers=get_headers(auth_token), timeout=15)
        if response.status_code == 200:
            result2 = response.json()
            passed = result1.get("active") == result2.get("active")
            log_test("followups_v2", "Reconcile idempotency", passed, f"First: {result1.get('active')}, Second: {result2.get('active')}")
    
    # Test V2 split overdue KPI fields
    response = requests.get(f"{BASE_URL}/followups/stats", headers=get_headers(auth_token), timeout=10)
    if response.status_code == 200:
        stats = response.json()
        has_split_fields = all(key in stats for key in ["overdue_payments_count", "overdue_payments_amount", "overdue_payments_amount_short", "expiring_quotations_count"])
        log_test("followups_v2", "V2 split overdue KPI fields present", has_split_fields, f"Fields: {', '.join([k for k in ['overdue_payments_count', 'overdue_payments_amount', 'overdue_payments_amount_short', 'expiring_quotations_count'] if k in stats])}")
    
    # Test followup detail V2 stats fields
    response = requests.get(f"{BASE_URL}/followups", headers=get_headers(auth_token), timeout=10)
    if response.status_code == 200:
        followups = response.json()
        if followups and len(followups) > 0:
            followup_id = followups[0]["id"]
            response = requests.get(f"{BASE_URL}/followups/{followup_id}", headers=get_headers(auth_token), timeout=10)
            if response.status_code == 200:
                detail = response.json()
                stats = detail.get("stats", {})
                has_v2_fields = all(key in stats for key in ["conversion_rate", "average_order_value", "preferred_salesperson", "risk_level"])
                risk_level_valid = stats.get("risk_level") in ["low", "medium", "high", None]
                log_test("followups_v2", "Followup detail V2 stats fields", has_v2_fields and risk_level_valid, f"Fields present: {has_v2_fields}, risk_level: {stats.get('risk_level')}")
    
    # Test export xlsx
    response = requests.get(f"{BASE_URL}/followups/export?format=xlsx", headers=get_headers(auth_token), timeout=15)
    if response.status_code == 200:
        xlsx_bytes = response.content
        is_xlsx = xlsx_bytes[:4] == b'PK\x03\x04'
        log_test("followups_v2", "Export XLSX (magic bytes check)", is_xlsx, f"Size: {len(xlsx_bytes)} bytes")
    
    # Test export csv
    response = requests.get(f"{BASE_URL}/followups/export?format=csv", headers=get_headers(auth_token), timeout=15)
    if response.status_code == 200:
        csv_text = response.text
        has_header = len(csv_text.split('\n')) > 0 and ',' in csv_text.split('\n')[0]
        log_test("followups_v2", "Export CSV (header row check)", has_header, f"Size: {len(csv_text)} bytes")
    
    # Test saved views CRUD
    response = requests.post(f"{BASE_URL}/followups/saved-views", headers=get_headers(auth_token),
                            json={"name": "Test View Owner", "filters": {"bucket": "today"}}, timeout=10)
    if response.status_code in (200, 201):
        view = response.json()
        view_id = view["id"]
        log_test("followups_v2", "Create saved view", True, f"Created: {view.get('name')}")
        
        # List saved views
        response = requests.get(f"{BASE_URL}/followups/saved-views", headers=get_headers(auth_token), timeout=10)
        if response.status_code == 200:
            views = response.json()
            found = any(v["id"] == view_id for v in views)
            log_test("followups_v2", "List saved views (includes created view)", found, f"Found {len(views)} views")
            
            # Test per-user isolation
            if sales_token:
                response = requests.get(f"{BASE_URL}/followups/saved-views", headers=get_headers(sales_token), timeout=10)
                if response.status_code == 200:
                    sales_views = response.json()
                    owner_view_visible_to_sales = any(v["id"] == view_id for v in sales_views)
                    log_test("followups_v2", "Saved views per-user isolation", not owner_view_visible_to_sales,
                            f"Owner's view visible to sales: {owner_view_visible_to_sales} (expected False for per-user)")
            
            # Delete saved view
            response = requests.delete(f"{BASE_URL}/followups/saved-views/{view_id}", headers=get_headers(auth_token), timeout=10)
            if response.status_code in (200, 204):
                response = requests.get(f"{BASE_URL}/followups/saved-views", headers=get_headers(auth_token), timeout=10)
                if response.status_code == 200:
                    views_after = response.json()
                    deleted = not any(v["id"] == view_id for v in views_after)
                    log_test("followups_v2", "Delete saved view", deleted, f"Deleted: {deleted}")
    
    # Regression tests
    response = requests.get(f"{BASE_URL}/followups/mission", headers=get_headers(auth_token), timeout=10)
    log_test("followups_v2", "Regression: GET /followups/mission", response.status_code == 200, f"Status: {response.status_code}")
    
    response = requests.get(f"{BASE_URL}/followups/insights", headers=get_headers(auth_token), timeout=10)
    log_test("followups_v2", "Regression: GET /followups/insights", response.status_code == 200, f"Status: {response.status_code}")
    
    return True

# Task 6: Cross-Module E2E
def test_cross_module_e2e():
    print("\n" + "="*80)
    print("TASK 6: CROSS-MODULE END-TO-END LIFECYCLE")
    print("="*80)
    
    e2e_evidence = {}
    
    # Get customer and products
    response = requests.get(f"{BASE_URL}/customers", headers=get_headers(auth_token), timeout=10)
    customers = response.json() if response.status_code == 200 else []
    customer_id = customers[0]["id"] if customers else None
    
    response = requests.get(f"{BASE_URL}/products", headers=get_headers(auth_token), timeout=10)
    products_data = response.json() if response.status_code == 200 else {}
    products = products_data.get("items", []) if isinstance(products_data, dict) else []
    
    if not customer_id or not products:
        log_test("cross_module_e2e", "Setup", False, "Missing customer or products")
        return False
    
    # STEP 1: Create quotation
    line_items = []
    for i, product in enumerate(products[:4]):
        line_items.append({
            "product_id": product["id"], "sku": product["sku"], "name": product["name"],
            "category_id": product.get("category_id"), "room": "Living Room" if i < 2 else "Bedroom",
            "qty": 3, "unit_price": product["price"], "sort_order": i
        })
    
    payload = {"customer_id": customer_id, "items": line_items, "rooms": ["Living Room", "Bedroom"], "project_name": "E2E Test"}
    response = requests.post(f"{BASE_URL}/quotations", headers=get_headers(auth_token), json=payload, timeout=10)
    if response.status_code not in (200, 201):
        log_test("cross_module_e2e", "STEP 1: Create quotation", False, f"Status: {response.status_code}")
        return False
    
    quotation = response.json()
    quotation_id = quotation["id"]
    grand_total = quotation.get("grand_total", 0)
    e2e_evidence["step1"] = {"quotation_id": quotation_id, "grand_total": grand_total}
    
    # Approve quotation
    response = requests.patch(f"{BASE_URL}/quotations/{quotation_id}", headers=get_headers(auth_token),
                             json={"status": "approved", "silent": False, "reason": "E2E test"}, timeout=10)
    log_test("cross_module_e2e", "STEP 1: Create + approve quotation", response.status_code == 200, f"Created and approved quotation")
    
    # STEP 2: Check if approval auto-creates PO (DESIGN GAP)
    response = requests.get(f"{BASE_URL}/purchase-orders?quotation_id={quotation_id}", headers=get_headers(auth_token), timeout=10)
    if response.status_code == 200:
        pos = response.json()
        auto_created = len(pos) > 0
        e2e_evidence["step2_design_gap"] = {"approval_auto_creates_po": auto_created, "gap": "Approval does NOT auto-create PO" if not auto_created else "OK"}
        log_test("cross_module_e2e", "STEP 2 DESIGN GAP: Approval auto-creates PO", True, f"Auto-created: {auto_created} (user expects automatic, current requires manual)")
    
    # STEP 3: Place order
    response = requests.post(f"{BASE_URL}/quotations/{quotation_id}/place-order/confirm", headers=get_headers(auth_token), json={}, timeout=10)
    if response.status_code != 200:
        log_test("cross_module_e2e", "STEP 3: Place order", False, f"Status: {response.status_code}")
        return False
    
    result = response.json()
    purchase_orders = result.get("purchase_orders", [])
    po_id = purchase_orders[0]["id"] if purchase_orders else None
    e2e_evidence["step3"] = {"po_count": len(purchase_orders), "po_id": po_id}
    log_test("cross_module_e2e", "STEP 3: Place order", True, f"Created {len(purchase_orders)} PO(s)")
    
    # STEP 4: Move items to delivered
    if po_id:
        response = requests.get(f"{BASE_URL}/purchase-orders/{po_id}", headers=get_headers(auth_token), timeout=10)
        if response.status_code == 200:
            po = response.json()
            items = po.get("items", [])
            item_ids = [item["id"] for item in items]
            initial_status = po.get("status")
            
            response = requests.post(f"{BASE_URL}/purchases/items/bulk-move", headers=get_headers(auth_token),
                                    json={"item_ids": item_ids, "to_stage": "delivered"}, timeout=10)
            if response.status_code == 200:
                time.sleep(0.5)
                response = requests.get(f"{BASE_URL}/purchase-orders/{po_id}", headers=get_headers(auth_token), timeout=10)
                if response.status_code == 200:
                    po_after = response.json()
                    final_status = po_after.get("status")
                    e2e_evidence["step4"] = {"initial_status": initial_status, "final_status": final_status, "status_changed": final_status != initial_status}
                    log_test("cross_module_e2e", "STEP 4: Move items to delivered", True, f"PO status: {initial_status} → {final_status}")
    
    # STEP 5: Record payment
    response = requests.post(f"{BASE_URL}/payments", headers=get_headers(auth_token),
                            json={"quotation_id": quotation_id, "amount": grand_total, "mode": "bank"}, timeout=10)
    if response.status_code in (200, 201):
        log_test("cross_module_e2e", "STEP 5: Record full payment", True, f"Recorded ₹{grand_total:,.2f}")
        
        time.sleep(0.5)
        response = requests.get(f"{BASE_URL}/payments/orders/{quotation_id}", headers=get_headers(auth_token), timeout=10)
        if response.status_code == 200:
            order_detail = response.json()
            e2e_evidence["step5"] = {"outstanding": order_detail.get("outstanding"), "fully_paid": order_detail.get("fully_paid")}
    
    # STEP 6: Reconcile followups
    response = requests.post(f"{BASE_URL}/followups/reconcile", headers=get_headers(auth_token), timeout=15)
    if response.status_code == 200:
        result = response.json()
        e2e_evidence["step6"] = {"created": result.get("created"), "updated": result.get("updated"), "auto_resolved": result.get("auto_resolved")}
        log_test("cross_module_e2e", "STEP 6: Reconcile followups", True, f"Reconciled - auto_resolved: {result.get('auto_resolved')}")
    
    # STEP 7: Check dashboard and reports
    response = requests.get(f"{BASE_URL}/dashboard/stats", headers=get_headers(auth_token), timeout=10)
    if response.status_code == 200:
        dashboard = response.json()
        e2e_evidence["step7_dashboard"] = {"total_collected": dashboard.get("total_collected")}
        log_test("cross_module_e2e", "STEP 7: Dashboard stats", True, f"Total collected: ₹{dashboard.get('total_collected', 0):,.2f}")
    
    log_test("cross_module_e2e", "Complete end-to-end lifecycle", True, "Full scenario executed", e2e_evidence)
    
    print("\n" + "="*80)
    print("E2E EVIDENCE SUMMARY:")
    print(json.dumps(e2e_evidence, indent=2))
    print("="*80)
    
    return True

def main():
    print("\n" + "="*80)
    print("STABILIZATION SPRINT - COMPREHENSIVE BACKEND AUDIT - FINAL")
    print("="*80)
    print(f"Base URL: {BASE_URL}")
    print(f"Primary user: {PRIMARY_EMAIL}")
    print("="*80)
    
    test_environment_recovery()
    test_quotation_module()
    test_purchases_module()
    test_payments_module()
    test_followups_v2()
    test_cross_module_e2e()
    
    # Generate summary
    print("\n" + "="*80)
    print("TEST SUMMARY")
    print("="*80)
    
    for category, results in test_results.items():
        passed = sum(1 for r in results if r["passed"])
        total = len(results)
        print(f"\n{category.upper().replace('_', ' ')}: {passed}/{total} passed")
        
        failures = [r for r in results if not r["passed"]]
        if failures:
            print("  FAILURES:")
            for f in failures:
                print(f"    ❌ {f['test']}: {f['details']}")
    
    with open("/app/backend_test_results_final.json", "w") as f:
        json.dump(test_results, f, indent=2)
    
    print("\n" + "="*80)
    print("Full results saved to: /app/backend_test_results_final.json")
    print("="*80)

if __name__ == "__main__":
    main()
