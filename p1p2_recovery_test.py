"""
P1/P2 Recovery Verification Test Suite
Tests backend catalog & pipeline health after ProductImage / seed patch

Priority 1: Product catalog endpoints (regression, must be green)
Priority 2: Catalog import pipeline endpoints (smoke)
Priority 3: Quotation regression
Priority 4: Pipeline importability (Python side)
"""
import os
import sys
import requests
from typing import Optional

# Backend URL configuration
BASE_URL = "http://localhost:8001"
API_BASE = f"{BASE_URL}/api"

# Test credentials from /app/memory/test_credentials.md
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

def test_priority_1_catalog(token: str):
    """Priority 1: Product catalog endpoints (regression, must be green)"""
    print("\n" + "="*80)
    print("PRIORITY 1: Product Catalog Endpoints (Regression)")
    print("="*80)
    
    headers = get_headers(token)
    
    # Test 1: GET /api/products?limit=50 - verify exactly 20 items, all have images field
    print("\n📦 Test 1: GET /api/products?limit=50")
    try:
        resp = requests.get(f"{API_BASE}/products?limit=50", headers=headers, timeout=10)
        if resp.status_code != 200:
            result.add_fail("P1.1: Products list", f"HTTP {resp.status_code}", {"response": resp.text[:400]})
            return
        
        data = resp.json()
        items = data.get("items", [])
        
        # Verify exactly 20 items
        if len(items) != 20:
            result.add_fail("P1.1: Products count", f"Expected exactly 20 items, got {len(items)}", {"count": len(items)})
        else:
            result.add_pass(f"P1.1: Products list returns exactly 20 items")
        
        # Verify every item has images field
        missing_images = []
        has_unsplash_pexels = []
        for item in items:
            if "images" not in item:
                missing_images.append(item.get("id", "unknown"))
            else:
                # Check for unsplash/pexels URLs
                images = item.get("images", [])
                if isinstance(images, list):
                    for img in images:
                        if isinstance(img, str) and ("unsplash.com" in img or "pexels.com" in img):
                            has_unsplash_pexels.append({"id": item.get("id"), "url": img})
        
        if missing_images:
            result.add_fail("P1.1: Images field", f"{len(missing_images)} items missing 'images' field", {"ids": missing_images})
        else:
            result.add_pass("P1.1: All items have 'images' field")
        
        if has_unsplash_pexels:
            result.add_fail("P1.1: No external CDN", f"{len(has_unsplash_pexels)} items have unsplash/pexels URLs", {"items": has_unsplash_pexels[:3]})
        else:
            result.add_pass("P1.1: No items contain unsplash.com or pexels.com URLs")
        
        # Store products for later tests
        global products_list
        products_list = items
        
    except Exception as e:
        result.add_fail("P1.1: Products list", f"Exception: {e}", None)
        return
    
    # Test 2: GET /api/products?q=grohe - verify filter works
    print("\n📦 Test 2: GET /api/products?q=grohe")
    try:
        resp = requests.get(f"{API_BASE}/products?q=grohe", headers=headers, timeout=10)
        if resp.status_code != 200:
            result.add_fail("P1.2: Search filter", f"HTTP {resp.status_code}", {"response": resp.text[:400]})
        else:
            data = resp.json()
            items = data.get("items", [])
            result.add_pass(f"P1.2: Search filter works (returned {len(items)} items)")
    except Exception as e:
        result.add_fail("P1.2: Search filter", f"Exception: {e}", None)
    
    # Test 3: GET /api/brands and verify 5 brands
    print("\n📦 Test 3: GET /api/brands")
    try:
        resp = requests.get(f"{API_BASE}/brands", headers=headers, timeout=10)
        if resp.status_code != 200:
            result.add_fail("P1.3: Brands list", f"HTTP {resp.status_code}", {"response": resp.text[:400]})
        else:
            brands = resp.json()
            if len(brands) != 5:
                result.add_fail("P1.3: Brands count", f"Expected 5 brands, got {len(brands)}", {"brands": [b.get("name") for b in brands]})
            else:
                expected_brands = ["Hansgrohe", "Axor", "Grohe", "Vitra", "Geberit"]
                brand_names = [b.get("name") for b in brands]
                if set(brand_names) == set(expected_brands):
                    result.add_pass(f"P1.3: Brands list returns 5 brands: {brand_names}")
                else:
                    result.add_fail("P1.3: Brands names", f"Brand names don't match expected", {"expected": expected_brands, "actual": brand_names})
            
            # Store first brand for filter test
            global first_brand_id
            first_brand_id = brands[0].get("id") if brands else None
    except Exception as e:
        result.add_fail("P1.3: Brands list", f"Exception: {e}", None)
    
    # Test 4: GET /api/categories and verify >=5 categories
    print("\n📦 Test 4: GET /api/categories")
    try:
        resp = requests.get(f"{API_BASE}/categories", headers=headers, timeout=10)
        if resp.status_code != 200:
            result.add_fail("P1.4: Categories list", f"HTTP {resp.status_code}", {"response": resp.text[:400]})
        else:
            categories = resp.json()
            if len(categories) < 5:
                result.add_fail("P1.4: Categories count", f"Expected ≥5 categories, got {len(categories)}", {"count": len(categories)})
            else:
                result.add_pass(f"P1.4: Categories list returns {len(categories)} categories (≥5)")
            
            # Store first category for filter test
            global first_category_id
            first_category_id = categories[0].get("id") if categories else None
    except Exception as e:
        result.add_fail("P1.4: Categories list", f"Exception: {e}", None)
    
    # Test 5: GET /api/products?brand_id=X - verify brand filter
    print("\n📦 Test 5: GET /api/products?brand_id={brand_id}")
    if first_brand_id:
        try:
            resp = requests.get(f"{API_BASE}/products?brand_id={first_brand_id}", headers=headers, timeout=10)
            if resp.status_code != 200:
                result.add_fail("P1.5: Brand filter", f"HTTP {resp.status_code}", {"response": resp.text[:400]})
            else:
                data = resp.json()
                items = data.get("items", [])
                # Verify all items have the same brand_id
                wrong_brand = [item.get("id") for item in items if item.get("brand_id") != first_brand_id]
                if wrong_brand:
                    result.add_fail("P1.5: Brand filter", f"{len(wrong_brand)} items have wrong brand_id", {"ids": wrong_brand[:3]})
                else:
                    result.add_pass(f"P1.5: Brand filter works (returned {len(items)} items)")
        except Exception as e:
            result.add_fail("P1.5: Brand filter", f"Exception: {e}", None)
    else:
        result.add_fail("P1.5: Brand filter", "No brand_id available for testing", None)
    
    # Test 6: GET /api/products?category_id=X - verify category filter
    print("\n📦 Test 6: GET /api/products?category_id={category_id}")
    if first_category_id:
        try:
            resp = requests.get(f"{API_BASE}/products?category_id={first_category_id}", headers=headers, timeout=10)
            if resp.status_code != 200:
                result.add_fail("P1.6: Category filter", f"HTTP {resp.status_code}", {"response": resp.text[:400]})
            else:
                data = resp.json()
                items = data.get("items", [])
                # Verify all items have the same category_id
                wrong_category = [item.get("id") for item in items if item.get("category_id") != first_category_id]
                if wrong_category:
                    result.add_fail("P1.6: Category filter", f"{len(wrong_category)} items have wrong category_id", {"ids": wrong_category[:3]})
                else:
                    result.add_pass(f"P1.6: Category filter works (returned {len(items)} items)")
        except Exception as e:
            result.add_fail("P1.6: Category filter", f"Exception: {e}", None)
    else:
        result.add_fail("P1.6: Category filter", "No category_id available for testing", None)
    
    # Test 7: GET /api/products/{id} - verify variants field
    print("\n📦 Test 7: GET /api/products/{id} - verify variants field")
    if products_list:
        product_id = products_list[0].get("id")
        try:
            resp = requests.get(f"{API_BASE}/products/{product_id}", headers=headers, timeout=10)
            if resp.status_code != 200:
                result.add_fail("P1.7: Product detail", f"HTTP {resp.status_code}", {"response": resp.text[:400]})
            else:
                product = resp.json()
                if "variants" not in product:
                    result.add_fail("P1.7: Product detail", "Missing 'variants' field", {"product_id": product_id})
                else:
                    result.add_pass(f"P1.7: Product detail includes 'variants' field")
        except Exception as e:
            result.add_fail("P1.7: Product detail", f"Exception: {e}", None)
    else:
        result.add_fail("P1.7: Product detail", "No products available for testing", None)
    
    # Test 8: Verify HAN-FAU-001 and HAN-FAU-002 have non-empty variants
    print("\n📦 Test 8: Verify HAN-FAU-001 and HAN-FAU-002 have non-empty variants")
    for sku in ["HAN-FAU-001", "HAN-FAU-002"]:
        # Find product by SKU
        product = next((p for p in products_list if p.get("sku") == sku), None)
        if product:
            product_id = product.get("id")
            try:
                resp = requests.get(f"{API_BASE}/products/{product_id}", headers=headers, timeout=10)
                if resp.status_code != 200:
                    result.add_fail(f"P1.8: {sku} variants", f"HTTP {resp.status_code}", {"response": resp.text[:400]})
                else:
                    product_detail = resp.json()
                    variants = product_detail.get("variants", [])
                    if not variants or len(variants) == 0:
                        result.add_fail(f"P1.8: {sku} variants", f"Expected non-empty variants, got {len(variants)}", {"sku": sku})
                    else:
                        result.add_pass(f"P1.8: {sku} has {len(variants)} variants")
            except Exception as e:
                result.add_fail(f"P1.8: {sku} variants", f"Exception: {e}", None)
        else:
            result.add_fail(f"P1.8: {sku} variants", f"Product with SKU {sku} not found in catalog", None)
    
    # Test 9: GET /api/products/recent
    print("\n📦 Test 9: GET /api/products/recent")
    try:
        resp = requests.get(f"{API_BASE}/products/recent", headers=headers, timeout=10)
        if resp.status_code != 200:
            result.add_fail("P1.9: Recent products", f"HTTP {resp.status_code}", {"response": resp.text[:400]})
        else:
            data = resp.json()
            if not isinstance(data, list):
                result.add_fail("P1.9: Recent products", "Response is not an array", {"response": data})
            else:
                result.add_pass(f"P1.9: Recent products endpoint works (returned {len(data)} items)")
    except Exception as e:
        result.add_fail("P1.9: Recent products", f"Exception: {e}", None)
    
    # Test 10: GET /api/products/frequent
    print("\n📦 Test 10: GET /api/products/frequent")
    try:
        resp = requests.get(f"{API_BASE}/products/frequent", headers=headers, timeout=10)
        if resp.status_code != 200:
            result.add_fail("P1.10: Frequent products", f"HTTP {resp.status_code}", {"response": resp.text[:400]})
        else:
            data = resp.json()
            if not isinstance(data, list):
                result.add_fail("P1.10: Frequent products", "Response is not an array", {"response": data})
            else:
                result.add_pass(f"P1.10: Frequent products endpoint works (returned {len(data)} items)")
    except Exception as e:
        result.add_fail("P1.10: Frequent products", f"Exception: {e}", None)
    
    # Test 11: GET /api/products/{id}/alternates?limit=5
    print("\n📦 Test 11: GET /api/products/{id}/alternates?limit=5")
    if products_list:
        product_id = products_list[0].get("id")
        try:
            resp = requests.get(f"{API_BASE}/products/{product_id}/alternates?limit=5", headers=headers, timeout=10)
            if resp.status_code != 200:
                result.add_fail("P1.11: Alternates endpoint", f"HTTP {resp.status_code}", {"response": resp.text[:400]})
            else:
                data = resp.json()
                # Verify shape
                if "source_product_id" not in data:
                    result.add_fail("P1.11: Alternates shape", "Missing 'source_product_id'", {"response": data})
                elif "items" not in data or not isinstance(data["items"], list):
                    result.add_fail("P1.11: Alternates shape", "Missing or invalid 'items' array", {"response": data})
                elif "tiers" not in data or not isinstance(data["tiers"], dict):
                    result.add_fail("P1.11: Alternates shape", "Missing or invalid 'tiers' object", {"response": data})
                else:
                    tiers = data["tiers"]
                    if not all(k in tiers for k in ["family", "brand_category", "category"]):
                        result.add_fail("P1.11: Alternates tiers", "Tiers missing required keys", {"tiers": tiers})
                    else:
                        result.add_pass(f"P1.11: Alternates endpoint returns correct shape (items: {len(data['items'])}, tiers: {tiers})")
        except Exception as e:
            result.add_fail("P1.11: Alternates endpoint", f"Exception: {e}", None)
    else:
        result.add_fail("P1.11: Alternates endpoint", "No products available for testing", None)

def test_priority_2_catalog_import(token: str):
    """Priority 2: Catalog import pipeline endpoints (smoke)"""
    print("\n" + "="*80)
    print("PRIORITY 2: Catalog Import Pipeline Endpoints (Smoke)")
    print("="*80)
    
    headers = get_headers(token)
    
    # Test 1: GET /api/catalog/imports/config/brands
    print("\n📦 Test 1: GET /api/catalog/imports/config/brands")
    try:
        resp = requests.get(f"{API_BASE}/catalog/imports/config/brands", headers=headers, timeout=10)
        if resp.status_code != 200:
            result.add_fail("P2.1: Brands config", f"HTTP {resp.status_code}", {"response": resp.text[:400]})
        else:
            data = resp.json()
            if "brands" not in data:
                result.add_fail("P2.1: Brands config", "Missing 'brands' key", {"response": data})
            else:
                brands = data["brands"]
                expected_brands = ["Hansgrohe", "Axor", "Grohe", "Vitra", "Geberit"]
                if not all(b in brands for b in expected_brands):
                    result.add_fail("P2.1: Brands config", f"Missing expected brands", {"expected": expected_brands, "actual": brands})
                else:
                    result.add_pass(f"P2.1: Brands config includes all expected brands: {brands}")
    except Exception as e:
        result.add_fail("P2.1: Brands config", f"Exception: {e}", None)
    
    # Test 2: GET /api/catalog/imports
    print("\n📦 Test 2: GET /api/catalog/imports")
    try:
        resp = requests.get(f"{API_BASE}/catalog/imports", headers=headers, timeout=10)
        if resp.status_code != 200:
            result.add_fail("P2.2: List imports", f"HTTP {resp.status_code}", {"response": resp.text[:400]})
        else:
            data = resp.json()
            if not isinstance(data, list):
                result.add_fail("P2.2: List imports", "Response is not an array", {"response": data})
            else:
                result.add_pass(f"P2.2: List imports endpoint works (returned {len(data)} jobs)")
    except Exception as e:
        result.add_fail("P2.2: List imports", f"Exception: {e}", None)
    
    # Test 3: Verify auth required
    print("\n📦 Test 3: Verify /api/catalog/imports requires authentication")
    try:
        resp = requests.get(f"{API_BASE}/catalog/imports", timeout=10)
        if resp.status_code not in [401, 403]:
            result.add_fail("P2.3: Auth required", f"Expected 401/403, got {resp.status_code}", {"response": resp.text[:400]})
        else:
            result.add_pass(f"P2.3: Endpoint requires auth (returned {resp.status_code})")
    except Exception as e:
        result.add_fail("P2.3: Auth required", f"Exception: {e}", None)

def test_priority_3_quotation(token: str):
    """Priority 3: Quotation regression"""
    print("\n" + "="*80)
    print("PRIORITY 3: Quotation Regression")
    print("="*80)
    
    headers = get_headers(token)
    
    # Get a customer first
    print("\n📦 Step 0: Get a customer ID")
    try:
        resp = requests.get(f"{API_BASE}/customers", headers=headers, timeout=10)
        if resp.status_code != 200:
            result.add_fail("P3.0: Get customers", f"HTTP {resp.status_code}", {"response": resp.text[:400]})
            return
        
        customers = resp.json()
        if not customers:
            result.add_fail("P3.0: Get customers", "No customers found", None)
            return
        
        customer_id = customers[0].get("id")
        print(f"✅ Using customer ID: {customer_id}")
        
    except Exception as e:
        result.add_fail("P3.0: Get customers", f"Exception: {e}", None)
        return
    
    # Test 1: POST /api/quotations
    print("\n📦 Test 1: POST /api/quotations")
    try:
        resp = requests.post(
            f"{API_BASE}/quotations",
            headers=headers,
            json={
                "customer_id": customer_id,
                "items": []
            },
            timeout=10
        )
        if resp.status_code not in [200, 201]:
            result.add_fail("P3.1: Create quotation", f"HTTP {resp.status_code}", {"response": resp.text[:400]})
            return
        
        quotation = resp.json()
        quotation_id = quotation.get("id")
        
        if not quotation_id:
            result.add_fail("P3.1: Create quotation", "No 'id' in response", {"response": quotation})
            return
        
        result.add_pass(f"P3.1: Create quotation (ID: {quotation_id})")
        
        # Store for next tests
        global test_quotation_id
        test_quotation_id = quotation_id
        
    except Exception as e:
        result.add_fail("P3.1: Create quotation", f"Exception: {e}", None)
        return
    
    # Test 2: PATCH /api/quotations/{id} with silent=true
    print("\n📦 Test 2: PATCH /api/quotations/{id} with silent=true")
    try:
        resp = requests.patch(
            f"{API_BASE}/quotations/{test_quotation_id}",
            headers=headers,
            json={
                "silent": True,
                "notes": "product image regression test"
            },
            timeout=10
        )
        if resp.status_code != 200:
            result.add_fail("P3.2: Silent PATCH", f"HTTP {resp.status_code}", {"response": resp.text[:400]})
        else:
            result.add_pass("P3.2: Silent PATCH works")
    except Exception as e:
        result.add_fail("P3.2: Silent PATCH", f"Exception: {e}", None)
    
    # Test 3: Verify quotation with null image doesn't crash
    print("\n📦 Test 3: Create quotation with line item having null image")
    if products_list:
        product = products_list[0]
        try:
            resp = requests.post(
                f"{API_BASE}/quotations",
                headers=headers,
                json={
                    "customer_id": customer_id,
                    "items": [{
                        "product_id": product.get("id"),
                        "sku": product.get("sku"),
                        "name": product.get("name"),
                        "image": None,  # Explicitly null
                        "qty": 1,
                        "unit_price": product.get("price", 0)
                    }]
                },
                timeout=10
            )
            if resp.status_code not in [200, 201]:
                result.add_fail("P3.3: Quotation with null image", f"HTTP {resp.status_code}", {"response": resp.text[:400]})
            else:
                result.add_pass("P3.3: Quotation with null image doesn't crash")
        except Exception as e:
            result.add_fail("P3.3: Quotation with null image", f"Exception: {e}", None)
    else:
        result.add_fail("P3.3: Quotation with null image", "No products available for testing", None)
    
    # Test 4: Verify alternates work with images=[]
    print("\n📦 Test 4: Verify alternates endpoint works when source product has images=[]")
    # Find a product with empty images array
    product_with_empty_images = None
    for p in products_list:
        if isinstance(p.get("images"), list) and len(p.get("images", [])) == 0:
            product_with_empty_images = p
            break
    
    if product_with_empty_images:
        product_id = product_with_empty_images.get("id")
        try:
            resp = requests.get(f"{API_BASE}/products/{product_id}/alternates", headers=headers, timeout=10)
            if resp.status_code != 200:
                result.add_fail("P3.4: Alternates with empty images", f"HTTP {resp.status_code}", {"response": resp.text[:400]})
            else:
                data = resp.json()
                if "items" not in data:
                    result.add_fail("P3.4: Alternates with empty images", "Missing 'items' in response", {"response": data})
                else:
                    result.add_pass(f"P3.4: Alternates work with images=[] (returned {len(data['items'])} items)")
        except Exception as e:
            result.add_fail("P3.4: Alternates with empty images", f"Exception: {e}", None)
    else:
        # All products should have empty images after the patch, so this is unexpected
        result.add_fail("P3.4: Alternates with empty images", "No product with images=[] found (unexpected)", None)

def main():
    """Main test runner"""
    print("="*80)
    print("P1/P2 RECOVERY VERIFICATION TEST")
    print("Backend Catalog & Pipeline Health After ProductImage/Seed Patch")
    print("="*80)
    print(f"Backend URL: {API_BASE}")
    print(f"Test User: {TEST_EMAIL}")
    
    # Login
    token = login()
    
    # Run all priority tests
    test_priority_1_catalog(token)
    test_priority_2_catalog_import(token)
    test_priority_3_quotation(token)
    
    # Summary
    success = result.summary()
    
    if success:
        print("\n🎉 ALL TESTS PASSED!")
        sys.exit(0)
    else:
        print(f"\n⚠️  {result.failed} TEST(S) FAILED")
        sys.exit(1)

if __name__ == "__main__":
    main()
