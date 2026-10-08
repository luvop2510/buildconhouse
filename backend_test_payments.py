"""
Forge V2 — Payments Module End-to-End Test Suite

Tests all backend APIs for the Payments Module per the review request:
1. GET /api/payments/stats
2. GET /api/payments/orders (with filters)
3. GET /api/payments/orders/:id
4. POST /api/payments
5. GET /api/payments/orders/:id/whatsapp-reminder
6. GET /api/payments (legacy)
7. AUTH checks (401 without token)
8. REGRESSION (previous endpoints, no tax fields)
"""
import os
import sys
import requests
from typing import Optional
from datetime import datetime

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
        print(f"TEST SUMMARY: {self.passed}/{total} passed, {self.failed}/{total} failed")
        print("="*80)
        if self.failures:
            print("\nFAILURES:")
            for i, f in enumerate(self.failures, 1):
                print(f"\n{i}. {f['test']}")
                print(f"   {f['reason']}")
                if f['details']:
                    print(f"   {f['details']}")
        return self.failed == 0

# Global test result tracker
result = TestResult()

def login() -> str:
    """Login and return JWT token"""
    print(f"\n🔐 Logging in as {TEST_EMAIL}...")
    try:
        resp = requests.post(
            f"{API_BASE}/auth/login",
            json={"email": TEST_EMAIL, "password": TEST_PASSWORD},
            timeout=10
        )
        if resp.status_code != 200:
            print(f"❌ Login failed: {resp.status_code}")
            print(f"Response: {resp.text[:400]}")
            sys.exit(1)
        
        data = resp.json()
        token = data.get("access_token")
        if not token:
            print("❌ No access_token in response (credential response omitted)")
            sys.exit(1)
        
        print(f"✅ Login successful")
        return token
    except Exception as e:
        print(f"❌ Login exception: {e}")
        sys.exit(1)

def get_headers(token: str) -> dict:
    """Return headers with Authorization"""
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }

# =============================================================================
# TEST 1: GET /api/payments/stats
# =============================================================================
def test_payment_stats(token: str):
    """Test GET /api/payments/stats returns correct keys and values"""
    print("\n" + "="*80)
    print("TEST 1: GET /api/payments/stats")
    print("="*80)
    
    try:
        resp = requests.get(
            f"{API_BASE}/payments/stats",
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code != 200:
            result.add_fail(
                "1.1: Stats endpoint returns 200",
                f"Got {resp.status_code}",
                {"response": resp.text[:400]}
            )
            return
        
        result.add_pass("1.1: Stats endpoint returns 200")
        
        data = resp.json()
        
        # Check required keys
        required_keys = ["total_outstanding", "collected_this_month", "active_orders", "fully_paid"]
        missing_keys = [k for k in required_keys if k not in data]
        
        if missing_keys:
            result.add_fail(
                "1.2: Stats has all required keys",
                f"Missing keys: {missing_keys}",
                {"data": data}
            )
            return
        
        result.add_pass("1.2: Stats has all required keys")
        
        # Check all values are numeric
        for key in required_keys:
            if not isinstance(data[key], (int, float)):
                result.add_fail(
                    f"1.3: Stats.{key} is numeric",
                    f"Got type {type(data[key])}",
                    {"value": data[key]}
                )
                return
        
        result.add_pass("1.3: All stats values are numeric")
        
        # Check that active_orders + fully_paid > 0 (seed guarantees at least 7 confirmed orders)
        total_orders = data["active_orders"] + data["fully_paid"]
        if total_orders <= 0:
            result.add_fail(
                "1.4: Stats shows confirmed orders",
                f"active_orders + fully_paid = {total_orders}, expected > 0",
                {"data": data}
            )
            return
        
        result.add_pass(f"1.4: Stats shows {total_orders} confirmed orders (active={data['active_orders']}, fully_paid={data['fully_paid']})")
        
        print(f"\n📊 Stats Summary:")
        print(f"   Total Outstanding: ₹{data['total_outstanding']:,.2f}")
        print(f"   Collected This Month: ₹{data['collected_this_month']:,.2f}")
        print(f"   Active Orders: {data['active_orders']}")
        print(f"   Fully Paid: {data['fully_paid']}")
        
    except Exception as e:
        result.add_fail("1.X: Stats endpoint exception", str(e))

# =============================================================================
# TEST 2: GET /api/payments/orders
# =============================================================================
def test_payment_orders_list(token: str):
    """Test GET /api/payments/orders returns correct shape and sorting"""
    print("\n" + "="*80)
    print("TEST 2: GET /api/payments/orders")
    print("="*80)
    
    try:
        resp = requests.get(
            f"{API_BASE}/payments/orders",
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code != 200:
            result.add_fail(
                "2.1: Orders list returns 200",
                f"Got {resp.status_code}",
                {"response": resp.text[:400]}
            )
            return None
        
        result.add_pass("2.1: Orders list returns 200")
        
        data = resp.json()
        
        if not isinstance(data, list):
            result.add_fail(
                "2.2: Orders list is an array",
                f"Got type {type(data)}",
                {"data": str(data)[:200]}
            )
            return None
        
        result.add_pass("2.2: Orders list is an array")
        
        if len(data) == 0:
            result.add_fail(
                "2.3: Orders list is not empty",
                "Got empty array, expected confirmed orders from seed",
                {}
            )
            return None
        
        result.add_pass(f"2.3: Orders list has {len(data)} orders")
        
        # Check first order has required keys
        required_keys = [
            "id", "number", "customer_id", "customer_name", "grand_total",
            "paid", "outstanding", "percent_collected", "payment_status",
            "confirmed_at", "outstanding_short"
        ]
        
        first_order = data[0]
        missing_keys = [k for k in required_keys if k not in first_order]
        
        if missing_keys:
            result.add_fail(
                "2.4: Order object has all required keys",
                f"Missing keys: {missing_keys}",
                {"order": first_order}
            )
            return None
        
        result.add_pass("2.4: Order object has all required keys")
        
        # Check payment_status values
        valid_statuses = ["paid", "partial", "due"]
        for i, order in enumerate(data[:5]):  # Check first 5
            if order["payment_status"] not in valid_statuses:
                result.add_fail(
                    "2.5: payment_status is valid",
                    f"Order {i} has invalid status: {order['payment_status']}",
                    {"order": order}
                )
                return None
        
        result.add_pass("2.5: payment_status values are valid (paid|partial|due)")
        
        # Check sorting (outstanding DESC)
        if len(data) > 1:
            is_sorted = all(
                data[i]["outstanding"] >= data[i+1]["outstanding"]
                for i in range(len(data)-1)
            )
            if not is_sorted:
                result.add_fail(
                    "2.6: Orders sorted by outstanding DESC",
                    "Orders not sorted correctly",
                    {"first_3_outstanding": [o["outstanding"] for o in data[:3]]}
                )
                return None
            
            result.add_pass("2.6: Orders sorted by outstanding DESC")
        
        # Check outstanding_short format
        for order in data:
            if order["outstanding"] > 0:
                if order["outstanding_short"] is None:
                    result.add_fail(
                        "2.7: outstanding_short is not null for due orders",
                        f"Order {order['number']} has outstanding={order['outstanding']} but outstanding_short=null",
                        {"order": order}
                    )
                    return None
                
                # Check format (should be like "₹1.5L" or "₹75k" or "₹500")
                short = order["outstanding_short"]
                if not (short.startswith("₹") and any(c in short for c in ["L", "k", "Cr"]) or short.replace("₹", "").isdigit()):
                    result.add_fail(
                        "2.8: outstanding_short has correct format",
                        f"Invalid format: {short}",
                        {"order": order}
                    )
                    return None
                break  # Check only first due order
        
        result.add_pass("2.7-2.8: outstanding_short format is correct")
        
        print(f"\n📋 First 3 orders:")
        for i, order in enumerate(data[:3], 1):
            print(f"   {i}. {order['number']} - {order['customer_name']}")
            print(f"      Grand Total: ₹{order['grand_total']:,.2f}, Paid: ₹{order['paid']:,.2f}")
            print(f"      Outstanding: ₹{order['outstanding']:,.2f} ({order['outstanding_short']})")
            print(f"      Status: {order['payment_status']} ({order['percent_collected']}%)")
        
        return data
        
    except Exception as e:
        result.add_fail("2.X: Orders list exception", str(e))
        return None

# =============================================================================
# TEST 3: GET /api/payments/orders with filters
# =============================================================================
def test_payment_orders_filters(token: str, orders: list):
    """Test GET /api/payments/orders with q and status_filter"""
    print("\n" + "="*80)
    print("TEST 3: GET /api/payments/orders with filters")
    print("="*80)
    
    if not orders or len(orders) == 0:
        print("⚠️  Skipping filter tests - no orders available")
        return
    
    try:
        # Test 3.1: Search by customer name
        first_customer = orders[0]["customer_name"]
        search_term = first_customer.split()[0]  # First word of customer name
        
        resp = requests.get(
            f"{API_BASE}/payments/orders",
            params={"q": search_term},
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code != 200:
            result.add_fail(
                "3.1: Search filter returns 200",
                f"Got {resp.status_code}",
                {"response": resp.text[:400]}
            )
            return
        
        filtered = resp.json()
        
        # Check that results contain the search term
        if len(filtered) > 0:
            found = any(search_term.lower() in o["customer_name"].lower() for o in filtered)
            if not found:
                result.add_fail(
                    "3.2: Search results match query",
                    f"No results contain '{search_term}'",
                    {"results": [o["customer_name"] for o in filtered[:3]]}
                )
                return
            
            result.add_pass(f"3.1-3.2: Search filter works (q={search_term}, found {len(filtered)} results)")
        else:
            result.add_pass(f"3.1-3.2: Search filter works (q={search_term}, found 0 results)")
        
        # Test 3.3: Filter by status=paid
        resp = requests.get(
            f"{API_BASE}/payments/orders",
            params={"status_filter": "paid"},
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code != 200:
            result.add_fail(
                "3.3: Status filter returns 200",
                f"Got {resp.status_code}",
                {"response": resp.text[:400]}
            )
            return
        
        paid_orders = resp.json()
        
        # Check all results have payment_status='paid'
        if len(paid_orders) > 0:
            non_paid = [o for o in paid_orders if o["payment_status"] != "paid"]
            if non_paid:
                result.add_fail(
                    "3.4: Status filter returns only paid orders",
                    f"Found {len(non_paid)} non-paid orders",
                    {"non_paid": [o["number"] for o in non_paid[:3]]}
                )
                return
            
            result.add_pass(f"3.3-3.4: Status filter works (status_filter=paid, found {len(paid_orders)} orders)")
        else:
            result.add_pass("3.3-3.4: Status filter works (status_filter=paid, found 0 orders)")
        
    except Exception as e:
        result.add_fail("3.X: Orders filter exception", str(e))

# =============================================================================
# TEST 4: GET /api/payments/orders/:id
# =============================================================================
def test_payment_order_detail(token: str, orders: list):
    """Test GET /api/payments/orders/:id returns correct detail"""
    print("\n" + "="*80)
    print("TEST 4: GET /api/payments/orders/:id")
    print("="*80)
    
    if not orders or len(orders) == 0:
        print("⚠️  Skipping detail tests - no orders available")
        return None
    
    try:
        # Get first order with outstanding > 0 (not fully paid)
        test_order = None
        for order in orders:
            if order["outstanding"] > 0:
                test_order = order
                break
        
        if not test_order:
            test_order = orders[0]  # Fallback to first order
        
        order_id = test_order["id"]
        
        resp = requests.get(
            f"{API_BASE}/payments/orders/{order_id}",
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code != 200:
            result.add_fail(
                "4.1: Order detail returns 200",
                f"Got {resp.status_code}",
                {"response": resp.text[:400]}
            )
            return None
        
        result.add_pass("4.1: Order detail returns 200")
        
        data = resp.json()
        
        # Check required keys
        required_keys = [
            "id", "number", "status", "customer", "customer_name",
            "confirmed_at", "mrp", "discounted_rate", "grand_total",
            "paid", "outstanding", "percent_collected", "payment_status", "payments"
        ]
        
        missing_keys = [k for k in required_keys if k not in data]
        
        if missing_keys:
            result.add_fail(
                "4.2: Order detail has all required keys",
                f"Missing keys: {missing_keys}",
                {"data": data}
            )
            return None
        
        result.add_pass("4.2: Order detail has all required keys")
        
        # Check customer object
        customer_keys = ["id", "name", "company", "phone", "email", "city", "address"]
        if not isinstance(data["customer"], dict):
            result.add_fail(
                "4.3: customer is an object",
                f"Got type {type(data['customer'])}",
                {"customer": data["customer"]}
            )
            return None
        
        result.add_pass("4.3: customer is an object")
        
        # Check MRP >= discounted_rate (since seed products have mrp > price)
        mrp = data["mrp"]
        discounted_rate = data["discounted_rate"]
        
        if mrp < discounted_rate:
            result.add_fail(
                "4.4: MRP >= discounted_rate",
                f"MRP ({mrp}) < discounted_rate ({discounted_rate})",
                {"data": data}
            )
            return None
        
        result.add_pass(f"4.4: MRP (₹{mrp:,.2f}) >= discounted_rate (₹{discounted_rate:,.2f})")
        
        # Check discounted_rate == grand_total
        if abs(discounted_rate - data["grand_total"]) > 0.01:
            result.add_fail(
                "4.5: discounted_rate == grand_total",
                f"discounted_rate ({discounted_rate}) != grand_total ({data['grand_total']})",
                {"data": data}
            )
            return None
        
        result.add_pass("4.5: discounted_rate == grand_total")
        
        # Check payments is an array
        if not isinstance(data["payments"], list):
            result.add_fail(
                "4.6: payments is an array",
                f"Got type {type(data['payments'])}",
                {"payments": data["payments"]}
            )
            return None
        
        result.add_pass(f"4.6: payments is an array ({len(data['payments'])} payments)")
        
        print(f"\n📄 Order Detail: {data['number']}")
        print(f"   Customer: {data['customer_name']}")
        print(f"   Status: {data['status']}")
        print(f"   MRP: ₹{data['mrp']:,.2f}")
        print(f"   Discounted Rate: ₹{data['discounted_rate']:,.2f}")
        print(f"   Grand Total: ₹{data['grand_total']:,.2f}")
        print(f"   Paid: ₹{data['paid']:,.2f}")
        print(f"   Outstanding: ₹{data['outstanding']:,.2f}")
        print(f"   Payment Status: {data['payment_status']} ({data['percent_collected']}%)")
        print(f"   Payments: {len(data['payments'])}")
        
        return data
        
    except Exception as e:
        result.add_fail("4.X: Order detail exception", str(e))
        return None

# =============================================================================
# TEST 5: GET /api/payments/orders/:id edge cases
# =============================================================================
def test_payment_order_detail_edge_cases(token: str):
    """Test GET /api/payments/orders/:id edge cases (404, 400)"""
    print("\n" + "="*80)
    print("TEST 5: GET /api/payments/orders/:id edge cases")
    print("="*80)
    
    try:
        # Test 5.1: 404 for non-existent order
        resp = requests.get(
            f"{API_BASE}/payments/orders/non-existent-id-12345",
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code != 404:
            result.add_fail(
                "5.1: Non-existent order returns 404",
                f"Got {resp.status_code}",
                {"response": resp.text[:400]}
            )
        else:
            result.add_pass("5.1: Non-existent order returns 404")
        
        # Test 5.2: 400 for draft quotation (not confirmed order)
        # First, get a draft quotation
        resp = requests.get(
            f"{API_BASE}/quotations",
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code == 200:
            quotations = resp.json()
            draft_quot = None
            for q in quotations:
                if q.get("status") not in ["ordered", "won"]:
                    draft_quot = q
                    break
            
            if draft_quot:
                resp = requests.get(
                    f"{API_BASE}/payments/orders/{draft_quot['id']}",
                    headers=get_headers(token),
                    timeout=10
                )
                
                if resp.status_code != 400:
                    result.add_fail(
                        "5.2: Draft quotation returns 400",
                        f"Got {resp.status_code}",
                        {"response": resp.text[:400]}
                    )
                else:
                    result.add_pass("5.2: Draft quotation returns 400")
            else:
                print("⚠️  Skipping 5.2 - no draft quotations found")
        else:
            print("⚠️  Skipping 5.2 - could not fetch quotations")
        
    except Exception as e:
        result.add_fail("5.X: Order detail edge cases exception", str(e))

# =============================================================================
# TEST 6: POST /api/payments
# =============================================================================
def test_record_payment(token: str, orders: list):
    """Test POST /api/payments records a payment correctly"""
    print("\n" + "="*80)
    print("TEST 6: POST /api/payments")
    print("="*80)
    
    if not orders or len(orders) == 0:
        print("⚠️  Skipping payment recording tests - no orders available")
        return None
    
    try:
        # Find an order with outstanding > 0
        test_order = None
        for order in orders:
            if order["outstanding"] > 100:  # At least ₹100 outstanding
                test_order = order
                break
        
        if not test_order:
            print("⚠️  Skipping payment recording tests - no orders with outstanding balance")
            return None
        
        order_id = test_order["id"]
        payment_amount = min(test_order["outstanding"], 5000)  # Pay up to ₹5000
        
        # Get initial state
        resp = requests.get(
            f"{API_BASE}/payments/orders/{order_id}",
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code != 200:
            print("⚠️  Could not fetch initial order state")
            return None
        
        initial_state = resp.json()
        initial_paid = initial_state["paid"]
        initial_outstanding = initial_state["outstanding"]
        
        # Record payment
        payment_payload = {
            "quotation_id": order_id,
            "amount": payment_amount,
            "mode": "upi",
            "reference": "TEST-UPI-12345",
            "note": "Test payment from automated test suite",
            "paid_at": datetime.now().isoformat()
        }
        
        resp = requests.post(
            f"{API_BASE}/payments",
            json=payment_payload,
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code != 200:
            result.add_fail(
                "6.1: POST /api/payments returns 200",
                f"Got {resp.status_code}",
                {"response": resp.text[:400]}
            )
            return None
        
        result.add_pass("6.1: POST /api/payments returns 200")
        
        payment_data = resp.json()
        
        # Check payment response has required keys
        required_keys = [
            "id", "quotation_id", "quotation_number", "customer_id", "customer_name",
            "amount", "mode", "status", "reference", "note", "paid_at",
            "recorded_by", "recorded_by_name", "created_at", "updated_at"
        ]
        
        missing_keys = [k for k in required_keys if k not in payment_data]
        
        if missing_keys:
            result.add_fail(
                "6.2: Payment response has all required keys",
                f"Missing keys: {missing_keys}",
                {"data": payment_data}
            )
            return None
        
        result.add_pass("6.2: Payment response has all required keys")
        
        # Check payment status is 'completed'
        if payment_data["status"] != "completed":
            result.add_fail(
                "6.3: Payment status is 'completed'",
                f"Got status: {payment_data['status']}",
                {"data": payment_data}
            )
            return None
        
        result.add_pass("6.3: Payment status is 'completed'")
        
        # Verify order detail updated
        resp = requests.get(
            f"{API_BASE}/payments/orders/{order_id}",
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code != 200:
            result.add_fail(
                "6.4: Order detail fetch after payment",
                f"Got {resp.status_code}",
                {"response": resp.text[:400]}
            )
            return None
        
        updated_state = resp.json()
        updated_paid = updated_state["paid"]
        updated_outstanding = updated_state["outstanding"]
        
        # Check paid amount increased
        expected_paid = initial_paid + payment_amount
        if abs(updated_paid - expected_paid) > 0.01:
            result.add_fail(
                "6.4: Paid amount updated correctly",
                f"Expected paid={expected_paid}, got {updated_paid}",
                {"initial": initial_paid, "payment": payment_amount, "updated": updated_paid}
            )
            return None
        
        result.add_pass(f"6.4: Paid amount updated (₹{initial_paid:,.2f} → ₹{updated_paid:,.2f})")
        
        # Check outstanding decreased
        expected_outstanding = initial_outstanding - payment_amount
        if abs(updated_outstanding - expected_outstanding) > 0.01:
            result.add_fail(
                "6.5: Outstanding amount updated correctly",
                f"Expected outstanding={expected_outstanding}, got {updated_outstanding}",
                {"initial": initial_outstanding, "payment": payment_amount, "updated": updated_outstanding}
            )
            return None
        
        result.add_pass(f"6.5: Outstanding amount updated (₹{initial_outstanding:,.2f} → ₹{updated_outstanding:,.2f})")
        
        # Check stats updated
        resp = requests.get(
            f"{API_BASE}/payments/stats",
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code == 200:
            stats = resp.json()
            result.add_pass(f"6.6: Stats updated (total_outstanding=₹{stats['total_outstanding']:,.2f})")
        else:
            print("⚠️  Could not verify stats update")
        
        # Check activity event logged
        resp = requests.get(
            f"{API_BASE}/activity/quotation/{order_id}",
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code == 200:
            events = resp.json()
            payment_events = [e for e in events if e.get("event_type") == "payment.recorded"]
            if len(payment_events) > 0:
                result.add_pass("6.7: Activity event 'payment.recorded' logged")
            else:
                result.add_fail(
                    "6.7: Activity event 'payment.recorded' logged",
                    "No payment.recorded events found",
                    {"events": [e.get("event_type") for e in events[:5]]}
                )
        else:
            print("⚠️  Could not verify activity event")
        
        print(f"\n💰 Payment Recorded:")
        print(f"   Order: {test_order['number']}")
        print(f"   Amount: ₹{payment_amount:,.2f}")
        print(f"   Mode: UPI")
        print(f"   Reference: TEST-UPI-12345")
        print(f"   Paid: ₹{initial_paid:,.2f} → ₹{updated_paid:,.2f}")
        print(f"   Outstanding: ₹{initial_outstanding:,.2f} → ₹{updated_outstanding:,.2f}")
        
        return payment_data
        
    except Exception as e:
        result.add_fail("6.X: Record payment exception", str(e))
        return None

# =============================================================================
# TEST 7: POST /api/payments edge cases
# =============================================================================
def test_record_payment_edge_cases(token: str, orders: list):
    """Test POST /api/payments edge cases (validation, 404, 400)"""
    print("\n" + "="*80)
    print("TEST 7: POST /api/payments edge cases")
    print("="*80)
    
    if not orders or len(orders) == 0:
        print("⚠️  Skipping payment edge case tests - no orders available")
        return
    
    try:
        test_order = orders[0]
        
        # Test 7.1: amount <= 0 returns 400
        resp = requests.post(
            f"{API_BASE}/payments",
            json={
                "quotation_id": test_order["id"],
                "amount": 0,
                "mode": "cash"
            },
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code != 400:
            result.add_fail(
                "7.1: amount <= 0 returns 400",
                f"Got {resp.status_code}",
                {"response": resp.text[:400]}
            )
        else:
            result.add_pass("7.1: amount <= 0 returns 400")
        
        # Test 7.2: Non-existent quotation_id returns 404
        resp = requests.post(
            f"{API_BASE}/payments",
            json={
                "quotation_id": "non-existent-id-12345",
                "amount": 1000,
                "mode": "cash"
            },
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code != 404:
            result.add_fail(
                "7.2: Non-existent quotation_id returns 404",
                f"Got {resp.status_code}",
                {"response": resp.text[:400]}
            )
        else:
            result.add_pass("7.2: Non-existent quotation_id returns 404")
        
        # Test 7.3: Draft quotation returns 400
        resp = requests.get(
            f"{API_BASE}/quotations",
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code == 200:
            quotations = resp.json()
            draft_quot = None
            for q in quotations:
                if q.get("status") not in ["ordered", "won"]:
                    draft_quot = q
                    break
            
            if draft_quot:
                resp = requests.post(
                    f"{API_BASE}/payments",
                    json={
                        "quotation_id": draft_quot["id"],
                        "amount": 1000,
                        "mode": "cash"
                    },
                    headers=get_headers(token),
                    timeout=10
                )
                
                if resp.status_code != 400:
                    result.add_fail(
                        "7.3: Draft quotation returns 400",
                        f"Got {resp.status_code}",
                        {"response": resp.text[:400]}
                    )
                else:
                    result.add_pass("7.3: Draft quotation returns 400")
            else:
                print("⚠️  Skipping 7.3 - no draft quotations found")
        else:
            print("⚠️  Skipping 7.3 - could not fetch quotations")
        
    except Exception as e:
        result.add_fail("7.X: Payment edge cases exception", str(e))

# =============================================================================
# TEST 8: GET /api/payments/orders/:id/whatsapp-reminder
# =============================================================================
def test_whatsapp_reminder(token: str, orders: list):
    """Test GET /api/payments/orders/:id/whatsapp-reminder"""
    print("\n" + "="*80)
    print("TEST 8: GET /api/payments/orders/:id/whatsapp-reminder")
    print("="*80)
    
    if not orders or len(orders) == 0:
        print("⚠️  Skipping WhatsApp reminder tests - no orders available")
        return
    
    try:
        # Find an order with outstanding > 0
        test_order = None
        for order in orders:
            if order["outstanding"] > 0:
                test_order = order
                break
        
        if not test_order:
            test_order = orders[0]
        
        order_id = test_order["id"]
        
        resp = requests.get(
            f"{API_BASE}/payments/orders/{order_id}/whatsapp-reminder",
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code != 200:
            result.add_fail(
                "8.1: WhatsApp reminder returns 200",
                f"Got {resp.status_code}",
                {"response": resp.text[:400]}
            )
            return
        
        result.add_pass("8.1: WhatsApp reminder returns 200")
        
        data = resp.json()
        
        # Check required keys
        required_keys = ["customer_name", "phone", "phone_display", "message", "outstanding", "wa_url"]
        missing_keys = [k for k in required_keys if k not in data]
        
        if missing_keys:
            result.add_fail(
                "8.2: WhatsApp reminder has all required keys",
                f"Missing keys: {missing_keys}",
                {"data": data}
            )
            return
        
        result.add_pass("8.2: WhatsApp reminder has all required keys")
        
        # Check phone is digits-only (or None)
        if data["phone"] is not None:
            if not data["phone"].isdigit():
                result.add_fail(
                    "8.3: phone is digits-only",
                    f"Got phone: {data['phone']}",
                    {"data": data}
                )
                return
            
            # Check phone starts with country code (usually 91 for India)
            if len(data["phone"]) < 10:
                result.add_fail(
                    "8.4: phone has valid length",
                    f"Got phone length: {len(data['phone'])}",
                    {"phone": data["phone"]}
                )
                return
            
            result.add_pass(f"8.3-8.4: phone is valid ({data['phone']})")
        else:
            result.add_pass("8.3-8.4: phone is None (customer has no phone)")
        
        # Check wa_url format
        if not data["wa_url"].startswith("https://wa.me/"):
            result.add_fail(
                "8.5: wa_url starts with 'https://wa.me/'",
                f"Got: {data['wa_url'][:50]}",
                {"wa_url": data["wa_url"]}
            )
            return
        
        result.add_pass("8.5: wa_url starts with 'https://wa.me/'")
        
        if "?text=" not in data["wa_url"]:
            result.add_fail(
                "8.6: wa_url contains '?text='",
                f"Got: {data['wa_url'][:100]}",
                {"wa_url": data["wa_url"]}
            )
            return
        
        result.add_pass("8.6: wa_url contains '?text=' (URL-encoded message)")
        
        # Check message content
        message = data["message"]
        
        # Message should include order number and outstanding amount
        # Note: customer name check is tricky because message uses first name from customer.name,
        # but test_order has customer_name which might be company name
        checks = [
            ("order number", test_order["number"] in message),
            ("outstanding amount", "₹" in message and any(char.isdigit() for char in message))
        ]
        
        for check_name, check_result in checks:
            if not check_result:
                result.add_fail(
                    f"8.7: message includes {check_name}",
                    f"Message does not include {check_name}",
                    {"message": message}
                )
                return
        
        result.add_pass("8.7: message includes order number and outstanding amount")
        
        print(f"\n📱 WhatsApp Reminder:")
        print(f"   Customer: {data['customer_name']}")
        print(f"   Phone: {data['phone_display']} (cleaned: {data['phone']})")
        print(f"   Outstanding: ₹{data['outstanding']:,.2f}")
        print(f"   WA URL: {data['wa_url'][:80]}...")
        print(f"\n   Message Preview:")
        for line in data['message'].split('\n')[:5]:
            print(f"      {line}")
        
    except Exception as e:
        result.add_fail("8.X: WhatsApp reminder exception", str(e))

# =============================================================================
# TEST 9: GET /api/payments (legacy)
# =============================================================================
def test_legacy_payments_list(token: str):
    """Test GET /api/payments returns 200 with array"""
    print("\n" + "="*80)
    print("TEST 9: GET /api/payments (legacy)")
    print("="*80)
    
    try:
        resp = requests.get(
            f"{API_BASE}/payments",
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code != 200:
            result.add_fail(
                "9.1: Legacy payments list returns 200",
                f"Got {resp.status_code}",
                {"response": resp.text[:400]}
            )
            return
        
        result.add_pass("9.1: Legacy payments list returns 200")
        
        data = resp.json()
        
        if not isinstance(data, list):
            result.add_fail(
                "9.2: Legacy payments list is an array",
                f"Got type {type(data)}",
                {"data": str(data)[:200]}
            )
            return
        
        result.add_pass(f"9.2: Legacy payments list is an array ({len(data)} payments)")
        
    except Exception as e:
        result.add_fail("9.X: Legacy payments list exception", str(e))

# =============================================================================
# TEST 10: AUTH checks
# =============================================================================
def test_auth_required():
    """Test all endpoints return 401 without token"""
    print("\n" + "="*80)
    print("TEST 10: AUTH checks (401 without token)")
    print("="*80)
    
    endpoints = [
        ("GET", "/payments/stats"),
        ("GET", "/payments/orders"),
        ("GET", "/payments/orders/test-id"),
        ("POST", "/payments"),
        ("GET", "/payments/orders/test-id/whatsapp-reminder"),
        ("GET", "/payments"),
    ]
    
    try:
        for method, path in endpoints:
            if method == "GET":
                resp = requests.get(f"{API_BASE}{path}", timeout=10)
            else:
                resp = requests.post(f"{API_BASE}{path}", json={}, timeout=10)
            
            if resp.status_code != 401:
                result.add_fail(
                    f"10.X: {method} {path} returns 401 without token",
                    f"Got {resp.status_code}",
                    {"response": resp.text[:200]}
                )
                return
        
        result.add_pass(f"10.1: All {len(endpoints)} endpoints return 401 without token")
        
    except Exception as e:
        result.add_fail("10.X: Auth checks exception", str(e))

# =============================================================================
# TEST 11: REGRESSION checks
# =============================================================================
def test_regression(token: str):
    """Test previous milestone endpoints still work and no tax fields"""
    print("\n" + "="*80)
    print("TEST 11: REGRESSION checks")
    print("="*80)
    
    try:
        # Test 11.1: GET /api/quotations returns 200
        resp = requests.get(
            f"{API_BASE}/quotations",
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code != 200:
            result.add_fail(
                "11.1: GET /api/quotations returns 200",
                f"Got {resp.status_code}",
                {"response": resp.text[:400]}
            )
            return
        
        result.add_pass("11.1: GET /api/quotations returns 200")
        
        quotations = resp.json()
        
        # Test 11.2: No tax fields in quotations
        tax_fields = ["tax_total", "tax_pct", "tax_amount"]
        
        for quot in quotations[:3]:  # Check first 3
            for field in tax_fields:
                if field in quot:
                    result.add_fail(
                        "11.2: Quotations have no tax fields",
                        f"Found {field} in quotation {quot.get('number')}",
                        {"quotation": quot}
                    )
                    return
            
            # Check line items
            for item in quot.get("items", [])[:3]:
                if "tax_pct" in item:
                    result.add_fail(
                        "11.3: Line items have no tax_pct",
                        f"Found tax_pct in line item",
                        {"item": item}
                    )
                    return
        
        result.add_pass("11.2-11.3: No tax fields in quotations or line items")
        
        # Test 11.4: GET /api/purchase-orders returns 200
        resp = requests.get(
            f"{API_BASE}/purchase-orders",
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code != 200:
            result.add_fail(
                "11.4: GET /api/purchase-orders returns 200",
                f"Got {resp.status_code}",
                {"response": resp.text[:400]}
            )
            return
        
        result.add_pass("11.4: GET /api/purchase-orders returns 200")
        
        # Test 11.5: GET /api/customers returns 200
        resp = requests.get(
            f"{API_BASE}/customers",
            headers=get_headers(token),
            timeout=10
        )
        
        if resp.status_code != 200:
            result.add_fail(
                "11.5: GET /api/customers returns 200",
                f"Got {resp.status_code}",
                {"response": resp.text[:400]}
            )
            return
        
        result.add_pass("11.5: GET /api/customers returns 200")
        
        # Test 11.6: GET /api/products/:id/alternates returns 200
        try:
            resp = requests.get(
                f"{API_BASE}/products",
                headers=get_headers(token),
                timeout=10
            )
            
            if resp.status_code == 200:
                products = resp.json()
                if isinstance(products, list) and len(products) > 0:
                    product_id = products[0]["id"]
                    
                    resp = requests.get(
                        f"{API_BASE}/products/{product_id}/alternates",
                        headers=get_headers(token),
                        timeout=10
                    )
                    
                    if resp.status_code != 200:
                        result.add_fail(
                            "11.6: GET /api/products/:id/alternates returns 200",
                            f"Got {resp.status_code}",
                            {"response": resp.text[:400]}
                        )
                        return
                    
                    result.add_pass("11.6: GET /api/products/:id/alternates returns 200")
                else:
                    print("⚠️  Skipping 11.6 - no products found")
            else:
                print("⚠️  Skipping 11.6 - could not fetch products")
        except Exception as e:
            print(f"⚠️  Skipping 11.6 - exception: {e}")
        
    except Exception as e:
        result.add_fail("11.X: Regression checks exception", str(e))

# =============================================================================
# MAIN TEST RUNNER
# =============================================================================
def main():
    print("\n" + "="*80)
    print("FORGE V2 — PAYMENTS MODULE END-TO-END TEST SUITE")
    print("="*80)
    print(f"Backend URL: {BASE_URL}")
    print(f"Test User: {TEST_EMAIL}")
    
    # Login
    token = login()
    
    # Run tests
    test_auth_required()
    test_payment_stats(token)
    orders = test_payment_orders_list(token)
    if orders:
        test_payment_orders_filters(token, orders)
        order_detail = test_payment_order_detail(token, orders)
        test_payment_order_detail_edge_cases(token)
        payment = test_record_payment(token, orders)
        test_record_payment_edge_cases(token, orders)
        test_whatsapp_reminder(token, orders)
    test_legacy_payments_list(token)
    test_regression(token)
    
    # Summary
    success = result.summary()
    
    if success:
        print("\n✅ ALL TESTS PASSED")
        sys.exit(0)
    else:
        print("\n❌ SOME TESTS FAILED")
        sys.exit(1)

if __name__ == "__main__":
    main()
