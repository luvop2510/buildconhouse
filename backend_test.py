#!/usr/bin/env python3
"""
Backend Testing Script for BuildCon House - Qutone Catalog EXTENSION Verification
Tests the merge of QUTONE2.xlsx (14 new products) into the EXISTING Qutone brand.
Must verify: NO new brand created, 466 total Qutone products (452 old + 14 new), floor isolation.
"""
import os

import requests
import json
import sys
from typing import Dict, Any, Optional, List

# Backend URL from frontend/.env
BASE_URL = "https://buildcon-preview.preview.emergentagent.com/api"

# Test credentials from /app/memory/test_credentials.md
TEST_EMAIL = "owner@forge.app"
TEST_PASSWORD = os.environ["FORGE_TEST_OWNER_PASSWORD"]

# ANSI color codes for output
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
BLUE = "\033[94m"
RESET = "\033[0m"

class TestResult:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.failures = []
    
    def pass_test(self, test_name: str):
        self.passed += 1
        print(f"{GREEN}✅ PASS{RESET}: {test_name}")
    
    def fail_test(self, test_name: str, reason: str):
        self.failed += 1
        self.failures.append(f"{test_name}: {reason}")
        print(f"{RED}❌ FAIL{RESET}: {test_name}")
        print(f"   Reason: {reason}")
    
    def print_summary(self):
        total = self.passed + self.failed
        print(f"\n{'='*80}")
        print(f"TEST SUMMARY")
        print(f"{'='*80}")
        print(f"Total Tests: {total}")
        print(f"{GREEN}Passed: {self.passed}{RESET}")
        print(f"{RED}Failed: {self.failed}{RESET}")
        
        if self.failures:
            print(f"\n{RED}FAILED TESTS:{RESET}")
            for i, failure in enumerate(self.failures, 1):
                print(f"{i}. {failure}")
        
        return self.failed == 0


def login() -> Optional[str]:
    """Login and return JWT token"""
    print(f"\n{BLUE}{'='*80}{RESET}")
    print(f"{BLUE}AUTHENTICATION{RESET}")
    print(f"{BLUE}{'='*80}{RESET}")
    
    try:
        response = requests.post(
            f"{BASE_URL}/auth/login",
            json={"email": TEST_EMAIL, "password": TEST_PASSWORD},
            timeout=10
        )
        
        if response.status_code == 200:
            data = response.json()
            token = data.get("access_token")
            user = data.get("user", {})
            print(f"{GREEN}✅ Login successful{RESET}")
            print(f"   User: {user.get('full_name')} ({user.get('email')})")
            print(f"   Role: {user.get('role')}")
            return token
        else:
            print(f"{RED}❌ Login failed: {response.status_code}{RESET}")
            print(f"   Response: {response.text}")
            return None
    except Exception as e:
        print(f"{RED}❌ Login error: {str(e)}{RESET}")
        return None


def test_1_brands_ground_floor_no_duplicate(token: str, result: TestResult) -> Optional[str]:
    """
    Test 1: GET /api/brands with X-Floor-Id: ground-floor
    Must be exactly 4 tile brands: Modulo, Dimore, Nexion, Qutone.
    Must NOT contain "Qutone 2", "Qutone New", or any duplicate Qutone-like brand name.
    """
    print(f"\n{BLUE}{'='*80}{RESET}")
    print(f"{BLUE}TEST 1: GET /api/brands (X-Floor-Id: ground-floor) - NO Duplicate Qutone Brand{RESET}")
    print(f"{BLUE}{'='*80}{RESET}")
    
    qutone_brand_id = None
    
    try:
        response = requests.get(
            f"{BASE_URL}/brands",
            headers={
                "Authorization": f"Bearer {token}",
                "X-Floor-Id": "ground-floor"
            },
            timeout=10
        )
        
        if response.status_code != 200:
            result.fail_test("GET /api/brands (ground-floor)", f"Status {response.status_code}: {response.text}")
            return None
        
        brands = response.json()
        brand_names = [b.get("name") for b in brands]
        
        print(f"   Found {len(brands)} brands: {', '.join(brand_names)}")
        
        # Must be exactly 4 tile brands
        expected_brands = ["Modulo", "Dimore", "Nexion", "Qutone"]
        if len(brands) != 4:
            result.fail_test("GET /api/brands (ground-floor) - count", f"Expected exactly 4 brands, got {len(brands)}")
        elif set(brand_names) == set(expected_brands):
            result.pass_test("GET /api/brands (ground-floor) - exactly 4 tile brands: Modulo, Dimore, Nexion, Qutone")
        else:
            result.fail_test("GET /api/brands (ground-floor) - brand names", f"Expected {expected_brands}, got {brand_names}")
        
        # Must NOT contain duplicate Qutone-like names
        qutone_like = [name for name in brand_names if "qutone" in name.lower() or "qutone" in name.lower()]
        if len(qutone_like) > 1:
            result.fail_test("GET /api/brands (ground-floor) - duplicate Qutone", f"Found multiple Qutone-like brands: {qutone_like}")
        elif len(qutone_like) == 1 and qutone_like[0] == "Qutone":
            result.pass_test("GET /api/brands (ground-floor) - NO duplicate Qutone brand (only 'Qutone' exists)")
            # Get Qutone brand_id for later tests
            for brand in brands:
                if brand.get("name") == "Qutone":
                    qutone_brand_id = brand.get("id")
                    print(f"   Qutone brand_id: {qutone_brand_id}")
                    break
        else:
            result.fail_test("GET /api/brands (ground-floor) - Qutone missing", "Qutone brand not found")
        
        # Check for suspicious names
        suspicious = ["Qutone 2", "Qutone New", "Qutone2", "QUTONE2"]
        found_suspicious = [name for name in brand_names if name in suspicious]
        if found_suspicious:
            result.fail_test("GET /api/brands (ground-floor) - suspicious names", f"Found: {found_suspicious}")
        else:
            result.pass_test("GET /api/brands (ground-floor) - NO suspicious duplicate names (Qutone 2, Qutone New, etc.)")
        
        return qutone_brand_id
        
    except Exception as e:
        result.fail_test("GET /api/brands (ground-floor)", f"Exception: {str(e)}")
        return None


def test_2_qutone_total_count(token: str, result: TestResult):
    """
    Test 2: GET /api/products?q=qutone with X-Floor-Id: ground-floor
    Total should be 466 (452 original + 14 new).
    """
    print(f"\n{BLUE}{'='*80}{RESET}")
    print(f"{BLUE}TEST 2: GET /api/products?q=qutone (X-Floor-Id: ground-floor) - Total Count{RESET}")
    print(f"{BLUE}{'='*80}{RESET}")
    
    try:
        response = requests.get(
            f"{BASE_URL}/products",
            params={"q": "qutone"},
            headers={
                "Authorization": f"Bearer {token}",
                "X-Floor-Id": "ground-floor"
            },
            timeout=10
        )
        
        if response.status_code != 200:
            result.fail_test("GET /api/products?q=qutone (ground-floor)", f"Status {response.status_code}: {response.text}")
            return
        
        data = response.json()
        total = data.get("total", 0)
        
        print(f"   Total Qutone products: {total}")
        
        if total == 466:
            result.pass_test("GET /api/products?q=qutone (ground-floor) - total=466 (452 old + 14 new)")
        else:
            result.fail_test("GET /api/products?q=qutone (ground-floor) - count", f"Expected 466, got {total}")
        
    except Exception as e:
        result.fail_test("GET /api/products?q=qutone (ground-floor)", f"Exception: {str(e)}")


def test_3_timber_oak_new_product(token: str, result: TestResult):
    """
    Test 3: GET /api/products?q=TIMBER%20OAK with X-Floor-Id: ground-floor
    Total=1, new product with sku="QUTONE-GVT-TIMBEROAK-200X1200-MT", price=95, valid Supabase hero_image_url.
    """
    print(f"\n{BLUE}{'='*80}{RESET}")
    print(f"{BLUE}TEST 3: GET /api/products?q=TIMBER OAK (X-Floor-Id: ground-floor) - New Product{RESET}")
    print(f"{BLUE}{'='*80}{RESET}")
    
    try:
        response = requests.get(
            f"{BASE_URL}/products",
            params={"q": "TIMBER OAK"},
            headers={
                "Authorization": f"Bearer {token}",
                "X-Floor-Id": "ground-floor"
            },
            timeout=10
        )
        
        if response.status_code != 200:
            result.fail_test("GET /api/products?q=TIMBER OAK (ground-floor)", f"Status {response.status_code}: {response.text}")
            return
        
        data = response.json()
        total = data.get("total", 0)
        items = data.get("items", [])
        
        print(f"   Total: {total}")
        
        if total != 1:
            result.fail_test("GET /api/products?q=TIMBER OAK (ground-floor) - count", f"Expected 1, got {total}")
            return
        else:
            result.pass_test("GET /api/products?q=TIMBER OAK (ground-floor) - total=1")
        
        if not items:
            result.fail_test("GET /api/products?q=TIMBER OAK (ground-floor) - items", "No items returned")
            return
        
        product = items[0]
        
        # Check SKU
        expected_sku = "QUTONE-GVT-TIMBEROAK-200X1200-MT"
        actual_sku = product.get("sku", "")
        if actual_sku == expected_sku:
            result.pass_test(f"GET /api/products?q=TIMBER OAK - SKU correct: {expected_sku}")
        else:
            result.fail_test("GET /api/products?q=TIMBER OAK - SKU", f"Expected {expected_sku}, got {actual_sku}")
        
        # Check price
        price = product.get("price")
        if price == 95:
            result.pass_test("GET /api/products?q=TIMBER OAK - price=95")
        else:
            result.fail_test("GET /api/products?q=TIMBER OAK - price", f"Expected 95, got {price}")
        
        # Check hero_image_url (Supabase)
        hero_image_url = product.get("hero_image_url", "")
        if hero_image_url and "supabase" in hero_image_url:
            result.pass_test("GET /api/products?q=TIMBER OAK - valid Supabase hero_image_url")
            print(f"   Hero image URL: {hero_image_url[:80]}...")
        else:
            result.fail_test("GET /api/products?q=TIMBER OAK - hero_image_url", f"Invalid or missing Supabase URL: {hero_image_url}")
        
        print(f"   Product: {product.get('name')}")
        print(f"   SKU: {actual_sku}")
        print(f"   Price: {price}")
        
    except Exception as e:
        result.fail_test("GET /api/products?q=TIMBER OAK (ground-floor)", f"Exception: {str(e)}")


def test_4_spenza_new_product(token: str, result: TestResult):
    """
    Test 4: GET /api/products?q=SPENZA with X-Floor-Id: ground-floor
    Total=1, new product found.
    """
    print(f"\n{BLUE}{'='*80}{RESET}")
    print(f"{BLUE}TEST 4: GET /api/products?q=SPENZA (X-Floor-Id: ground-floor) - New Product{RESET}")
    print(f"{BLUE}{'='*80}{RESET}")
    
    try:
        response = requests.get(
            f"{BASE_URL}/products",
            params={"q": "SPENZA"},
            headers={
                "Authorization": f"Bearer {token}",
                "X-Floor-Id": "ground-floor"
            },
            timeout=10
        )
        
        if response.status_code != 200:
            result.fail_test("GET /api/products?q=SPENZA (ground-floor)", f"Status {response.status_code}: {response.text}")
            return
        
        data = response.json()
        total = data.get("total", 0)
        items = data.get("items", [])
        
        print(f"   Total: {total}")
        
        if total != 1:
            result.fail_test("GET /api/products?q=SPENZA (ground-floor) - count", f"Expected 1, got {total}")
        else:
            result.pass_test("GET /api/products?q=SPENZA (ground-floor) - total=1 (new product found)")
        
        if items:
            product = items[0]
            print(f"   Product: {product.get('name')}")
            print(f"   SKU: {product.get('sku')}")
            print(f"   Price: {product.get('price')}")
        
    except Exception as e:
        result.fail_test("GET /api/products?q=SPENZA (ground-floor)", f"Exception: {str(e)}")


def test_5_old_products_untouched(token: str, result: TestResult):
    """
    Test 5: Pick 2-3 product ids that are NOT part of the new 14
    (i.e. older Qutone products, or products from Vitra/Hansgrohe on first-floor)
    and call GET /api/products/{id} — confirm they still return correct full data
    (proving the merge did not corrupt/touch pre-existing catalog documents).
    """
    print(f"\n{BLUE}{'='*80}{RESET}")
    print(f"{BLUE}TEST 5: GET /api/products/{{id}} - Old Products Untouched{RESET}")
    print(f"{BLUE}{'='*80}{RESET}")
    
    # Get some old Qutone products (not TIMBER OAK or SPENZA)
    old_qutone_ids = []
    try:
        response = requests.get(
            f"{BASE_URL}/products",
            params={"q": "qutone", "limit": 50},
            headers={
                "Authorization": f"Bearer {token}",
                "X-Floor-Id": "ground-floor"
            },
            timeout=10
        )
        
        if response.status_code == 200:
            data = response.json()
            items = data.get("items", [])
            # Filter out the new products (TIMBER OAK, SPENZA, etc.)
            new_product_keywords = ["TIMBER", "SPENZA", "TIMBEROAK"]
            for item in items:
                name = item.get("name", "").upper()
                sku = item.get("sku", "").upper()
                if not any(keyword in name or keyword in sku for keyword in new_product_keywords):
                    old_qutone_ids.append(item.get("id"))
                    if len(old_qutone_ids) >= 2:
                        break
    except Exception as e:
        print(f"   Warning: Could not fetch old Qutone products: {e}")
    
    # Get some first-floor products (Vitra/Hansgrohe)
    first_floor_ids = []
    try:
        response = requests.get(
            f"{BASE_URL}/products",
            params={"q": "hansgrohe", "limit": 10},
            headers={
                "Authorization": f"Bearer {token}",
                "X-Floor-Id": "first-floor"
            },
            timeout=10
        )
        
        if response.status_code == 200:
            data = response.json()
            items = data.get("items", [])
            if items:
                first_floor_ids.append(items[0].get("id"))
    except Exception as e:
        print(f"   Warning: Could not fetch first-floor products: {e}")
    
    test_product_ids = old_qutone_ids + first_floor_ids
    
    if not test_product_ids:
        result.fail_test("GET /api/products/{id} - old products", "Could not find any old product IDs to test")
        return
    
    print(f"   Testing {len(test_product_ids)} old product IDs: {test_product_ids}")
    
    for product_id in test_product_ids:
        try:
            response = requests.get(
                f"{BASE_URL}/products/{product_id}",
                headers={
                    "Authorization": f"Bearer {token}",
                    "X-Floor-Id": "ground-floor"  # Will work for both floors
                },
                timeout=10
            )
            
            if response.status_code != 200:
                result.fail_test(f"GET /api/products/{product_id}", f"Status {response.status_code}")
                continue
            
            product = response.json()
            
            # Check required fields (brand_name is not in detail endpoint, only brand_id)
            required_fields = ["id", "name", "sku", "price", "brand_id"]
            missing_fields = [f for f in required_fields if f not in product or product[f] is None]
            
            if missing_fields:
                result.fail_test(f"GET /api/products/{product_id} - fields", f"Missing: {', '.join(missing_fields)}")
            else:
                result.pass_test(f"GET /api/products/{product_id} - old product data intact ({product.get('name')[:40]}...)")
            
        except Exception as e:
            result.fail_test(f"GET /api/products/{product_id}", f"Exception: {str(e)}")


def test_6_catalog_search_spenza_brand_id(token: str, qutone_brand_id: Optional[str], result: TestResult):
    """
    Test 6: GET /api/catalog/search?q=SPENZA with X-Floor-Id: ground-floor
    Confirm the result's brand_id matches the single existing Qutone brand (not a new brand_id).
    """
    print(f"\n{BLUE}{'='*80}{RESET}")
    print(f"{BLUE}TEST 6: GET /api/catalog/search?q=SPENZA (X-Floor-Id: ground-floor) - Brand ID Check{RESET}")
    print(f"{BLUE}{'='*80}{RESET}")
    
    if not qutone_brand_id:
        result.fail_test("GET /api/catalog/search?q=SPENZA - brand_id", "Qutone brand_id not available from Test 1")
        return
    
    try:
        response = requests.get(
            f"{BASE_URL}/catalog/search",
            params={"q": "SPENZA"},
            headers={
                "Authorization": f"Bearer {token}",
                "X-Floor-Id": "ground-floor"
            },
            timeout=10
        )
        
        if response.status_code != 200:
            result.fail_test("GET /api/catalog/search?q=SPENZA", f"Status {response.status_code}: {response.text}")
            return
        
        data = response.json()
        items = data.get("items", [])
        
        if not items:
            result.fail_test("GET /api/catalog/search?q=SPENZA", "No results returned")
            return
        
        # Check brand_id in the first result
        first_item = items[0]
        brand_id = first_item.get("brand_id")
        
        print(f"   Expected Qutone brand_id: {qutone_brand_id}")
        print(f"   SPENZA result brand_id: {brand_id}")
        
        if brand_id == qutone_brand_id:
            result.pass_test("GET /api/catalog/search?q=SPENZA - brand_id matches existing Qutone brand (NOT a new brand)")
        else:
            result.fail_test("GET /api/catalog/search?q=SPENZA - brand_id", f"Expected {qutone_brand_id}, got {brand_id} (NEW BRAND CREATED!)")
        
    except Exception as e:
        result.fail_test("GET /api/catalog/search?q=SPENZA", f"Exception: {str(e)}")


def test_7_floor_isolation_first_floor(token: str, result: TestResult):
    """
    Test 7: X-Floor-Id: first-floor
    GET /api/products?q=timber%20oak and GET /api/products?q=spenza
    Both must return total=0 (no leakage into Sanitary Bathroom).
    """
    print(f"\n{BLUE}{'='*80}{RESET}")
    print(f"{BLUE}TEST 7: Floor Isolation - First Floor (Sanitary Bathroom){RESET}")
    print(f"{BLUE}{'='*80}{RESET}")
    
    queries = ["timber oak", "spenza"]
    
    for query in queries:
        try:
            response = requests.get(
                f"{BASE_URL}/products",
                params={"q": query},
                headers={
                    "Authorization": f"Bearer {token}",
                    "X-Floor-Id": "first-floor"
                },
                timeout=10
            )
            
            if response.status_code != 200:
                result.fail_test(f"GET /api/products?q={query} (first-floor)", f"Status {response.status_code}")
                continue
            
            data = response.json()
            total = data.get("total", 0)
            
            print(f"   Query '{query}' on first-floor: total={total}")
            
            if total == 0:
                result.pass_test(f"GET /api/products?q={query} (first-floor) - total=0 (no leakage)")
            else:
                result.fail_test(f"GET /api/products?q={query} (first-floor) - floor isolation", f"Expected 0, got {total} (NEW PRODUCTS LEAKED INTO SANITARY BATHROOM!)")
            
        except Exception as e:
            result.fail_test(f"GET /api/products?q={query} (first-floor)", f"Exception: {str(e)}")


def test_8_regression_smoke(token: str, result: TestResult):
    """
    Test 8: Regression smoke
    GET /api/quotations, GET /api/customers, GET /api/payments/stats, GET /api/purchase-orders
    on both floors — all 200 OK.
    """
    print(f"\n{BLUE}{'='*80}{RESET}")
    print(f"{BLUE}TEST 8: Regression Smoke Tests{RESET}")
    print(f"{BLUE}{'='*80}{RESET}")
    
    endpoints = [
        ("/quotations", "ground-floor"),
        ("/quotations", "first-floor"),
        ("/customers", "ground-floor"),
        ("/customers", "first-floor"),
        ("/payments/stats", "ground-floor"),
        ("/payments/stats", "first-floor"),
        ("/purchase-orders", "ground-floor"),
        ("/purchase-orders", "first-floor"),
    ]
    
    for endpoint, floor_id in endpoints:
        try:
            response = requests.get(
                f"{BASE_URL}{endpoint}",
                headers={
                    "Authorization": f"Bearer {token}",
                    "X-Floor-Id": floor_id
                },
                timeout=10
            )
            
            if response.status_code == 200:
                result.pass_test(f"GET /api{endpoint} (X-Floor-Id: {floor_id}) - 200 OK")
            else:
                result.fail_test(f"GET /api{endpoint} (X-Floor-Id: {floor_id})", f"Status {response.status_code}")
        
        except Exception as e:
            result.fail_test(f"GET /api{endpoint} (X-Floor-Id: {floor_id})", f"Exception: {str(e)}")


def test_9_health_system(token: str, result: TestResult):
    """
    Test 9: GET /api/health/system
    healthy=true, 0 warnings, products count around 4377, brands count = 10 (not 11).
    """
    print(f"\n{BLUE}{'='*80}{RESET}")
    print(f"{BLUE}TEST 9: GET /api/health/system{RESET}")
    print(f"{BLUE}{'='*80}{RESET}")
    
    try:
        response = requests.get(
            f"{BASE_URL}/health/system",
            headers={"Authorization": f"Bearer {token}"},
            timeout=10
        )
        
        if response.status_code != 200:
            result.fail_test("GET /api/health/system", f"Status {response.status_code}: {response.text}")
            return
        
        data = response.json()
        
        # Check healthy=true
        if data.get("healthy") != True:
            result.fail_test("GET /api/health/system - healthy", f"healthy={data.get('healthy')}, expected True")
        else:
            result.pass_test("GET /api/health/system - healthy=true")
        
        # Check warnings=0
        warnings = data.get("warnings", [])
        if len(warnings) > 0:
            result.fail_test("GET /api/health/system - warnings", f"Found {len(warnings)} warnings: {warnings}")
        else:
            result.pass_test("GET /api/health/system - 0 warnings")
        
        # Check products count around 4377
        counts = data.get("counts", {})
        products_count = counts.get("products", 0)
        brands_count = counts.get("brands", 0)
        
        print(f"   Products count: {products_count}")
        print(f"   Brands count: {brands_count}")
        
        # Allow some variance (4370-4385 range)
        if 4370 <= products_count <= 4385:
            result.pass_test(f"GET /api/health/system - products count around 4377 (got {products_count})")
        else:
            result.fail_test("GET /api/health/system - products count", f"Expected ~4377, got {products_count}")
        
        # Check brands count = 10 (not 11)
        if brands_count == 10:
            result.pass_test("GET /api/health/system - brands count = 10 (NO new brand created)")
        else:
            result.fail_test("GET /api/health/system - brands count", f"Expected 10, got {brands_count} (NEW BRAND MAY HAVE BEEN CREATED!)")
        
        print(f"   Full counts: {counts}")
        
    except Exception as e:
        result.fail_test("GET /api/health/system", f"Exception: {str(e)}")


def main():
    print(f"\n{BLUE}{'='*80}{RESET}")
    print(f"{BLUE}BuildCon House - Qutone Catalog EXTENSION Backend Testing{RESET}")
    print(f"{BLUE}Testing merge of QUTONE2.xlsx (14 new products) into EXISTING Qutone brand{RESET}")
    print(f"{BLUE}{'='*80}{RESET}")
    print(f"Backend URL: {BASE_URL}")
    print(f"Test User: {TEST_EMAIL}")
    
    result = TestResult()
    
    # Step 1: Login
    token = login()
    if not token:
        print(f"\n{RED}FATAL: Cannot proceed without authentication token{RESET}")
        sys.exit(1)
    
    # Step 2: Run all tests in order
    qutone_brand_id = test_1_brands_ground_floor_no_duplicate(token, result)
    test_2_qutone_total_count(token, result)
    test_3_timber_oak_new_product(token, result)
    test_4_spenza_new_product(token, result)
    test_5_old_products_untouched(token, result)
    test_6_catalog_search_spenza_brand_id(token, qutone_brand_id, result)
    test_7_floor_isolation_first_floor(token, result)
    test_8_regression_smoke(token, result)
    test_9_health_system(token, result)
    
    # Step 3: Print summary
    success = result.print_summary()
    
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
