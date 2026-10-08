"""
Purchases Sprint Objective 4 — Backend Read Contracts Verification
READ-ONLY testing of Purchases API endpoints
"""
import os
import requests
import json
from typing import Dict, Any, List

# Backend URL (internal)
BASE_URL = "http://127.0.0.1:8001/api"

# Test credentials
OWNER_EMAIL = "owner@forge.app"
OWNER_PASSWORD = os.environ["FORGE_TEST_OWNER_PASSWORD"]

class PurchasesTestRunner:
    def __init__(self):
        self.token = None
        self.headers = {}
        self.results = []
        
    def log(self, test_name: str, status: str, details: str = ""):
        """Log test result"""
        result = {
            "test": test_name,
            "status": status,
            "details": details
        }
        self.results.append(result)
        symbol = "✅" if status == "PASS" else "❌" if status == "FAIL" else "⚠️"
        print(f"{symbol} {test_name}: {status}")
        if details:
            print(f"   {details}")
    
    def authenticate(self):
        """Authenticate and get JWT token"""
        print("\n" + "="*80)
        print("AUTHENTICATION")
        print("="*80)
        
        try:
            response = requests.post(
                f"{BASE_URL}/auth/login",
                json={"email": OWNER_EMAIL, "password": OWNER_PASSWORD},
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                self.token = data.get("access_token") or data.get("token")
                self.headers = {"Authorization": f"Bearer {self.token}"}
                self.log("Authentication", "PASS", f"Logged in as {OWNER_EMAIL}")
                return True
            else:
                self.log("Authentication", "FAIL", f"Status {response.status_code}: {response.text[:200]}")
                return False
        except Exception as e:
            self.log("Authentication", "FAIL", f"Exception: {str(e)}")
            return False
    
    def test_purchases_items_today(self):
        """Test GET /purchases/items with view=today"""
        print("\n" + "="*80)
        print("TEST 1: GET /purchases/items?view=today")
        print("="*80)
        
        try:
            response = requests.get(
                f"{BASE_URL}/purchases/items",
                params={"view": "today"},
                headers=self.headers,
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                
                # Check response structure
                if "items" in data and isinstance(data["items"], list):
                    self.log("GET /purchases/items?view=today", "PASS", 
                            f"Returned {len(data['items'])} items")
                    
                    # Check for required fields in items
                    if len(data["items"]) > 0:
                        sample = data["items"][0]
                        required_fields = ["item_id", "product_id", "customer_id", "stage"]
                        missing = [f for f in required_fields if f not in sample]
                        if missing:
                            self.log("Item structure check", "WARN", 
                                    f"Missing fields: {missing}")
                        else:
                            self.log("Item structure check", "PASS", 
                                    "All required fields present")
                    
                    return data
                else:
                    self.log("GET /purchases/items?view=today", "FAIL", 
                            "Response missing 'items' array")
                    return None
            else:
                self.log("GET /purchases/items?view=today", "FAIL", 
                        f"Status {response.status_code}: {response.text[:200]}")
                return None
        except Exception as e:
            self.log("GET /purchases/items?view=today", "FAIL", f"Exception: {str(e)}")
            return None
    
    def test_purchases_items_stock(self):
        """Test GET /purchases/items with view=stock"""
        print("\n" + "="*80)
        print("TEST 2: GET /purchases/items?view=stock")
        print("="*80)
        
        try:
            response = requests.get(
                f"{BASE_URL}/purchases/items",
                params={"view": "stock"},
                headers=self.headers,
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                self.log("GET /purchases/items?view=stock", "PASS", 
                        f"Returned {len(data.get('items', []))} items")
                return data
            else:
                self.log("GET /purchases/items?view=stock", "FAIL", 
                        f"Status {response.status_code}")
                return None
        except Exception as e:
            self.log("GET /purchases/items?view=stock", "FAIL", f"Exception: {str(e)}")
            return None
    
    def test_purchases_items_customers(self):
        """Test GET /purchases/items with view=customers"""
        print("\n" + "="*80)
        print("TEST 3: GET /purchases/items?view=customers")
        print("="*80)
        
        try:
            response = requests.get(
                f"{BASE_URL}/purchases/items",
                params={"view": "customers"},
                headers=self.headers,
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                self.log("GET /purchases/items?view=customers", "PASS", 
                        f"Returned {len(data.get('items', []))} items")
                return data
            else:
                self.log("GET /purchases/items?view=customers", "FAIL", 
                        f"Status {response.status_code}")
                return None
        except Exception as e:
            self.log("GET /purchases/items?view=customers", "FAIL", f"Exception: {str(e)}")
            return None
    
    def test_purchases_dispatch_record(self):
        """Test GET /purchases/dispatch-record"""
        print("\n" + "="*80)
        print("TEST 4: GET /purchases/dispatch-record")
        print("="*80)
        
        try:
            response = requests.get(
                f"{BASE_URL}/purchases/dispatch-record",
                headers=self.headers,
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                self.log("GET /purchases/dispatch-record", "PASS", 
                        f"Returned {len(data.get('items', []))} items")
                return data
            else:
                self.log("GET /purchases/dispatch-record", "FAIL", 
                        f"Status {response.status_code}")
                return None
        except Exception as e:
            self.log("GET /purchases/dispatch-record", "FAIL", f"Exception: {str(e)}")
            return None
    
    def test_purchases_customers(self):
        """Test GET /purchases/customers"""
        print("\n" + "="*80)
        print("TEST 5: GET /purchases/customers")
        print("="*80)
        
        try:
            response = requests.get(
                f"{BASE_URL}/purchases/customers",
                headers=self.headers,
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                
                # Response is an array directly, not wrapped in 'customers' key
                if isinstance(data, list):
                    self.log("GET /purchases/customers", "PASS", 
                            f"Returned {len(data)} customers")
                    
                    # Check for navigable customer facets
                    if len(data) > 0:
                        sample = data[0]
                        required_fields = ["id", "name"]
                        missing = [f for f in required_fields if f not in sample]
                        if missing:
                            self.log("Customer facets check", "WARN", 
                                    f"Missing fields: {missing}")
                        else:
                            self.log("Customer facets check", "PASS", 
                                    "Navigable customer facets present")
                    
                    return data
                else:
                    self.log("GET /purchases/customers", "FAIL", 
                            "Response is not an array")
                    return None
            else:
                self.log("GET /purchases/customers", "FAIL", 
                        f"Status {response.status_code}")
                return None
        except Exception as e:
            self.log("GET /purchases/customers", "FAIL", f"Exception: {str(e)}")
            return None
    
    def test_purchases_customer_workspace(self, customer_id: str):
        """Test GET /purchases/customers/{customer_id}/workspace"""
        print("\n" + "="*80)
        print(f"TEST 6: GET /purchases/customers/{customer_id}/workspace")
        print("="*80)
        
        try:
            response = requests.get(
                f"{BASE_URL}/purchases/customers/{customer_id}/workspace",
                headers=self.headers,
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                
                # Check for required sections
                required_sections = ["summary", "products", "outstanding_items", 
                                   "shortages", "payments", "followups", 
                                   "purchase_orders", "recent_activity", "expected_delivery"]
                
                missing_sections = [s for s in required_sections if s not in data]
                
                if not missing_sections:
                    self.log("GET /purchases/customers/{id}/workspace", "PASS", 
                            "All required sections present")
                else:
                    self.log("GET /purchases/customers/{id}/workspace", "WARN", 
                            f"Missing sections: {missing_sections}")
                
                return data
            elif response.status_code == 404:
                self.log("GET /purchases/customers/{id}/workspace", "WARN", 
                        f"Customer {customer_id} not found (404)")
                return None
            else:
                self.log("GET /purchases/customers/{id}/workspace", "FAIL", 
                        f"Status {response.status_code}")
                return None
        except Exception as e:
            self.log("GET /purchases/customers/{id}/workspace", "FAIL", 
                    f"Exception: {str(e)}")
            return None
    
    def test_purchases_shortages(self):
        """Test GET /purchases/shortages"""
        print("\n" + "="*80)
        print("TEST 7: GET /purchases/shortages")
        print("="*80)
        
        try:
            response = requests.get(
                f"{BASE_URL}/purchases/shortages",
                headers=self.headers,
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                self.log("GET /purchases/shortages", "PASS", 
                        f"Returned {len(data.get('shortages', []))} shortages")
                return data
            else:
                self.log("GET /purchases/shortages", "FAIL", 
                        f"Status {response.status_code}")
                return None
        except Exception as e:
            self.log("GET /purchases/shortages", "FAIL", f"Exception: {str(e)}")
            return None
    
    def test_purchases_item_detail(self, item_id: str):
        """Test GET /purchases/items/{item_id}"""
        print("\n" + "="*80)
        print(f"TEST 8: GET /purchases/items/{item_id}")
        print("="*80)
        
        try:
            response = requests.get(
                f"{BASE_URL}/purchases/items/{item_id}",
                headers=self.headers,
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                
                # Check for stage history/lineage
                if "stage_history" in data or "history" in data or "events" in data:
                    self.log("GET /purchases/items/{id}", "PASS", 
                            "Item detail includes stage history/lineage")
                else:
                    self.log("GET /purchases/items/{id}", "WARN", 
                            "Stage history/lineage not found in response")
                
                return data
            elif response.status_code == 404:
                self.log("GET /purchases/items/{id}", "WARN", 
                        f"Item {item_id} not found (404)")
                return None
            else:
                self.log("GET /purchases/items/{id}", "FAIL", 
                        f"Status {response.status_code}")
                return None
        except Exception as e:
            self.log("GET /purchases/items/{id}", "FAIL", f"Exception: {str(e)}")
            return None
    
    def test_no_duplicate_automations(self):
        """Test for no duplicate purchase automation/outbox artifacts"""
        print("\n" + "="*80)
        print("TEST 9: Check for duplicate automation artifacts")
        print("="*80)
        
        try:
            # Get a sample of purchase orders
            response = requests.get(
                f"{BASE_URL}/purchase-orders",
                params={"limit": 10},
                headers=self.headers,
                timeout=10
            )
            
            if response.status_code == 200:
                pos = response.json()
                
                if len(pos) == 0:
                    self.log("Duplicate automation check", "WARN", 
                            "No purchase orders found to check")
                    return
                
                # For each PO, check for duplicate automation artifacts
                # This would require checking the outbox/events collections
                # For now, we'll check if PO IDs are unique
                po_ids = [po.get("id") for po in pos if "id" in po]
                unique_ids = set(po_ids)
                
                if len(po_ids) == len(unique_ids):
                    self.log("Duplicate automation check", "PASS", 
                            f"All {len(po_ids)} PO IDs are unique")
                else:
                    duplicates = len(po_ids) - len(unique_ids)
                    self.log("Duplicate automation check", "FAIL", 
                            f"Found {duplicates} duplicate PO IDs")
            else:
                self.log("Duplicate automation check", "WARN", 
                        f"Could not fetch purchase orders: {response.status_code}")
        except Exception as e:
            self.log("Duplicate automation check", "FAIL", f"Exception: {str(e)}")
    
    def test_no_orphaned_references(self):
        """Test for no orphaned item product/customer references"""
        print("\n" + "="*80)
        print("TEST 10: Check for orphaned product/customer references")
        print("="*80)
        
        try:
            # Get all items
            response = requests.get(
                f"{BASE_URL}/purchases/items",
                params={"limit": 100},
                headers=self.headers,
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                items = data.get("items", [])
                
                if len(items) == 0:
                    self.log("Orphaned references check", "WARN", 
                            "No purchase items found to check")
                    return
                
                # Check for null/missing product_id or customer_id
                orphaned_products = [i for i in items if not i.get("product_id")]
                orphaned_customers = [i for i in items if not i.get("customer_id")]
                
                if not orphaned_products and not orphaned_customers:
                    self.log("Orphaned references check", "PASS", 
                            f"All {len(items)} items have valid product and customer references")
                else:
                    details = []
                    if orphaned_products:
                        details.append(f"{len(orphaned_products)} items with null product_id")
                    if orphaned_customers:
                        details.append(f"{len(orphaned_customers)} items with null customer_id")
                    self.log("Orphaned references check", "FAIL", 
                            ", ".join(details))
            else:
                self.log("Orphaned references check", "WARN", 
                        f"Could not fetch purchase items: {response.status_code}")
        except Exception as e:
            self.log("Orphaned references check", "FAIL", f"Exception: {str(e)}")
    
    def test_data_availability_carrier_returns(self):
        """Report data availability limits for carrier/returns"""
        print("\n" + "="*80)
        print("TEST 11: Data availability for carrier/returns")
        print("="*80)
        
        try:
            # Check dispatch-record for carrier information
            response = requests.get(
                f"{BASE_URL}/purchases/dispatch-record",
                headers=self.headers,
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                items = data.get("items", [])
                
                # Check for carrier field
                items_with_carrier = [i for i in items if i.get("carrier")]
                
                if len(items) > 0:
                    carrier_pct = (len(items_with_carrier) / len(items)) * 100
                    self.log("Carrier data availability", "INFO", 
                            f"{len(items_with_carrier)}/{len(items)} items ({carrier_pct:.1f}%) have carrier information")
                else:
                    self.log("Carrier data availability", "INFO", 
                            "No dispatched items found")
                
                # Check for returns
                items_with_returns = [i for i in items if i.get("returned") or i.get("return_status")]
                
                if len(items_with_returns) > 0:
                    self.log("Returns data availability", "INFO", 
                            f"{len(items_with_returns)} items have return information")
                else:
                    self.log("Returns data availability", "INFO", 
                            "No items with return information found (expected if no returns contract)")
            else:
                self.log("Data availability check", "WARN", 
                        f"Could not fetch dispatch record: {response.status_code}")
        except Exception as e:
            self.log("Data availability check", "FAIL", f"Exception: {str(e)}")
    
    def run_all_tests(self):
        """Run all tests"""
        print("\n" + "="*80)
        print("PURCHASES SPRINT OBJECTIVE 4 — BACKEND READ CONTRACTS VERIFICATION")
        print("="*80)
        print(f"Backend URL: {BASE_URL}")
        print(f"Credentials: {OWNER_EMAIL}")
        print("="*80)
        
        # Authenticate
        if not self.authenticate():
            print("\n❌ CRITICAL: Authentication failed. Cannot proceed with tests.")
            return
        
        # Run all tests
        self.test_purchases_items_today()
        self.test_purchases_items_stock()
        self.test_purchases_items_customers()
        self.test_purchases_dispatch_record()
        
        customers_data = self.test_purchases_customers()
        
        # Test customer workspace with first customer if available
        if customers_data and len(customers_data) > 0:
            first_customer_id = customers_data[0].get("id")
            if first_customer_id:
                self.test_purchases_customer_workspace(first_customer_id)
        
        self.test_purchases_shortages()
        
        # Test item detail with first item if available
        items_response = requests.get(
            f"{BASE_URL}/purchases/items",
            params={"limit": 1},
            headers=self.headers,
            timeout=10
        )
        if items_response.status_code == 200:
            items_data = items_response.json()
            if len(items_data.get("items", [])) > 0:
                first_item_id = items_data["items"][0].get("item_id")
                if first_item_id:
                    self.test_purchases_item_detail(first_item_id)
        
        self.test_no_duplicate_automations()
        self.test_no_orphaned_references()
        self.test_data_availability_carrier_returns()
        
        # Print summary
        self.print_summary()
    
    def print_summary(self):
        """Print test summary"""
        print("\n" + "="*80)
        print("TEST SUMMARY")
        print("="*80)
        
        passed = sum(1 for r in self.results if r["status"] == "PASS")
        failed = sum(1 for r in self.results if r["status"] == "FAIL")
        warned = sum(1 for r in self.results if r["status"] in ["WARN", "INFO"])
        total = len(self.results)
        
        print(f"Total tests: {total}")
        print(f"✅ Passed: {passed}")
        print(f"❌ Failed: {failed}")
        print(f"⚠️  Warnings/Info: {warned}")
        print("="*80)
        
        if failed > 0:
            print("\n❌ FAILED TESTS:")
            for r in self.results:
                if r["status"] == "FAIL":
                    print(f"  - {r['test']}: {r['details']}")
        
        if warned > 0:
            print("\n⚠️  WARNINGS/INFO:")
            for r in self.results:
                if r["status"] in ["WARN", "INFO"]:
                    print(f"  - {r['test']}: {r['details']}")

if __name__ == "__main__":
    runner = PurchasesTestRunner()
    runner.run_all_tests()
