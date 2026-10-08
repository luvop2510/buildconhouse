#!/usr/bin/env python3
"""
Backend Recovery & Health System Test
Tests the new /api/health/system endpoint and smoke regression after full outage recovery.
"""
import os
import requests
import json
from typing import Dict, Optional

# Configuration
BASE_URL = "https://buildcon-preview.preview.emergentagent.com/api"
PRIMARY_EMAIL = "owner@forge.app"
PRIMARY_PASSWORD = os.environ["FORGE_TEST_OWNER_PASSWORD"]

# Global state
auth_token = None
test_results = []

def log_test(test_name: str, passed: bool, details: str = "", evidence: Dict = None):
    """Log test result with evidence"""
    result = {
        "test": test_name,
        "passed": passed,
        "details": details,
        "evidence": evidence or {}
    }
    test_results.append(result)
    status = "✅ PASS" if passed else "❌ FAIL"
    print(f"{status}: {test_name}")
    if details:
        print(f"  {details}")
    if evidence and not passed:
        print(f"  Evidence: {json.dumps(evidence, indent=2)[:500]}")

def get_headers(token: str = None) -> Dict[str, str]:
    """Get request headers with optional auth token"""
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers

# ============================================================================
# TEST 1: NEW /api/health/system endpoint
# ============================================================================
def test_health_system():
    """Test the new /api/health/system endpoint (no auth required)"""
    print("\n" + "="*80)
    print("TEST 1: NEW /api/health/system endpoint")
    print("="*80)
    
    try:
        response = requests.get(f"{BASE_URL}/health/system", timeout=10)
        
        # Test 1.1: Endpoint returns 200
        log_test(
            "GET /api/health/system returns 200",
            response.status_code == 200,
            f"Status: {response.status_code}",
            {"status_code": response.status_code}
        )
        
        if response.status_code != 200:
            print(f"Response body: {response.text}")
            return
        
        data = response.json()
        
        # Test 1.2: Response shape verification
        required_keys = ["backend", "mongo", "supabase", "counts", "secrets_loaded", "warnings", "healthy"]
        missing_keys = [k for k in required_keys if k not in data]
        log_test(
            "Response has all required keys",
            len(missing_keys) == 0,
            f"Missing keys: {missing_keys}" if missing_keys else "All keys present",
            {"keys": list(data.keys()), "missing": missing_keys}
        )
        
        # Test 1.3: mongo.connected = true
        mongo_connected = data.get("mongo", {}).get("connected", False)
        log_test(
            "mongo.connected = true",
            mongo_connected is True,
            f"mongo.connected = {mongo_connected}",
            {"mongo": data.get("mongo")}
        )
        
        # Test 1.4: mongo.is_local = true (local mongod in container)
        mongo_is_local = data.get("mongo", {}).get("is_local", False)
        log_test(
            "mongo.is_local = true",
            mongo_is_local is True,
            f"mongo.is_local = {mongo_is_local}",
            {"mongo": data.get("mongo")}
        )
        
        # Test 1.5: supabase.configured = false (no Supabase keys set)
        supabase_configured = data.get("supabase", {}).get("configured", True)
        log_test(
            "supabase.configured = false",
            supabase_configured is False,
            f"supabase.configured = {supabase_configured}",
            {"supabase": data.get("supabase")}
        )
        
        # Test 1.6: counts reflect real DB counts
        counts = data.get("counts", {})
        expected_collections = ["products", "customers", "quotations", "purchase_orders", 
                               "payments", "followups", "users", "brands", "categories", "activity"]
        missing_counts = [c for c in expected_collections if c not in counts]
        log_test(
            "counts contains all expected collections",
            len(missing_counts) == 0,
            f"Missing: {missing_counts}" if missing_counts else f"All present. Products: {counts.get('products')}, Customers: {counts.get('customers')}, Quotations: {counts.get('quotations')}, Users: {counts.get('users')}",
            {"counts": counts, "missing": missing_counts}
        )
        
        # Test 1.7: products count ~20 (demo-seed)
        products_count = counts.get("products", 0)
        log_test(
            "products count ~20 (demo-seed)",
            15 <= products_count <= 25,
            f"products = {products_count}",
            {"products_count": products_count}
        )
        
        # Test 1.8: customers count ~4 (demo-seed)
        customers_count = counts.get("customers", 0)
        log_test(
            "customers count ~4 (demo-seed)",
            2 <= customers_count <= 6,
            f"customers = {customers_count}",
            {"customers_count": customers_count}
        )
        
        # Test 1.9: quotations count ~8 (demo-seed)
        quotations_count = counts.get("quotations", 0)
        log_test(
            "quotations count ~8 (demo-seed)",
            6 <= quotations_count <= 10,
            f"quotations = {quotations_count}",
            {"quotations_count": quotations_count}
        )
        
        # Test 1.10: users count ~8 (demo-seed)
        users_count = counts.get("users", 0)
        log_test(
            "users count ~8 (demo-seed)",
            6 <= users_count <= 10,
            f"users = {users_count}",
            {"users_count": users_count}
        )
        
        # Test 1.11: warnings array contains expected messages
        warnings = data.get("warnings", [])
        has_local_mongo_warning = any("local" in w.lower() or "ephemeral" in w.lower() for w in warnings)
        has_supabase_warning = any("supabase" in w.lower() for w in warnings)
        has_demo_seed_warning = any("demo-seed" in w.lower() or "demo seed" in w.lower() for w in warnings)
        
        log_test(
            "warnings array contains local mongo warning",
            has_local_mongo_warning,
            f"Found: {has_local_mongo_warning}",
            {"warnings": warnings}
        )
        
        log_test(
            "warnings array contains supabase not configured warning",
            has_supabase_warning,
            f"Found: {has_supabase_warning}",
            {"warnings": warnings}
        )
        
        log_test(
            "warnings array contains demo-seed catalog warning",
            has_demo_seed_warning,
            f"Found: {has_demo_seed_warning}",
            {"warnings": warnings}
        )
        
        # Test 1.12: healthy = true
        healthy = data.get("healthy", False)
        log_test(
            "healthy = true",
            healthy is True,
            f"healthy = {healthy}",
            {"healthy": healthy}
        )
        
        # Test 1.13: NEVER includes actual secret values
        response_str = json.dumps(data)
        has_mongo_url = "mongodb://" in response_str
        has_jwt_secret = len([v for v in str(data.get("secrets_loaded", {})).split() if len(v) > 30]) > 0
        
        log_test(
            "Response NEVER includes actual secret values",
            not has_mongo_url and not has_jwt_secret,
            f"No secrets found in response" if not (has_mongo_url or has_jwt_secret) else "WARNING: Possible secret leak",
            {"has_mongo_url": has_mongo_url, "has_jwt_secret": has_jwt_secret}
        )
        
        # Test 1.14: secrets_loaded contains expected booleans
        secrets_loaded = data.get("secrets_loaded", {})
        expected_secrets = ["MONGO_URL", "DB_NAME", "JWT_SECRET", "SUPABASE_URL", 
                           "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"]
        missing_secrets = [s for s in expected_secrets if s not in secrets_loaded]
        all_booleans = all(isinstance(v, bool) for v in secrets_loaded.values())
        
        log_test(
            "secrets_loaded contains all expected keys as booleans",
            len(missing_secrets) == 0 and all_booleans,
            f"Missing: {missing_secrets}" if missing_secrets else f"All present and boolean. MONGO_URL: {secrets_loaded.get('MONGO_URL')}, JWT_SECRET: {secrets_loaded.get('JWT_SECRET')}",
            {"secrets_loaded": secrets_loaded, "missing": missing_secrets, "all_booleans": all_booleans}
        )
        
    except Exception as e:
        log_test(
            "GET /api/health/system exception",
            False,
            f"Exception: {str(e)}",
            {"error": str(e)}
        )

# ============================================================================
# TEST 2: SMOKE REGRESSION - Core flows after venv reinstall
# ============================================================================
def test_smoke_regression():
    """Test core flows after full Python venv reinstall and .env recreation"""
    global auth_token
    print("\n" + "="*80)
    print("TEST 2: SMOKE REGRESSION - Core flows")
    print("="*80)
    
    # Test 2.1: POST /api/auth/login with owner@forge.app / [legacy credential removed]
    try:
        response = requests.post(
            f"{BASE_URL}/auth/login",
            json={"email": PRIMARY_EMAIL, "password": PRIMARY_PASSWORD},
            timeout=10
        )
        
        login_success = response.status_code == 200
        if login_success:
            data = response.json()
            auth_token = data.get("access_token")
            has_token = bool(auth_token)
        else:
            has_token = False
        
        log_test(
            "POST /api/auth/login → 200 with access_token",
            login_success and has_token,
            f"Status: {response.status_code}, Token: {'present' if has_token else 'missing'}",
            {"status_code": response.status_code, "has_token": has_token}
        )
        
        if not auth_token:
            print("❌ CRITICAL: Cannot proceed without auth token")
            return
            
    except Exception as e:
        log_test(
            "POST /api/auth/login exception",
            False,
            f"Exception: {str(e)}",
            {"error": str(e)}
        )
        return
    
    # Test 2.2: GET /api/quotations (auth) → 200
    try:
        response = requests.get(
            f"{BASE_URL}/quotations",
            headers=get_headers(auth_token),
            timeout=10
        )
        log_test(
            "GET /api/quotations (auth) → 200",
            response.status_code == 200,
            f"Status: {response.status_code}, Count: {len(response.json()) if response.status_code == 200 else 'N/A'}",
            {"status_code": response.status_code}
        )
    except Exception as e:
        log_test("GET /api/quotations exception", False, f"Exception: {str(e)}", {"error": str(e)})
    
    # Test 2.3: GET /api/customers (auth) → 200
    try:
        response = requests.get(
            f"{BASE_URL}/customers",
            headers=get_headers(auth_token),
            timeout=10
        )
        log_test(
            "GET /api/customers (auth) → 200",
            response.status_code == 200,
            f"Status: {response.status_code}, Count: {len(response.json()) if response.status_code == 200 else 'N/A'}",
            {"status_code": response.status_code}
        )
    except Exception as e:
        log_test("GET /api/customers exception", False, f"Exception: {str(e)}", {"error": str(e)})
    
    # Test 2.4: GET /api/payments/stats (auth) → 200
    try:
        response = requests.get(
            f"{BASE_URL}/payments/stats",
            headers=get_headers(auth_token),
            timeout=10
        )
        log_test(
            "GET /api/payments/stats (auth) → 200",
            response.status_code == 200,
            f"Status: {response.status_code}",
            {"status_code": response.status_code, "data": response.json() if response.status_code == 200 else None}
        )
    except Exception as e:
        log_test("GET /api/payments/stats exception", False, f"Exception: {str(e)}", {"error": str(e)})
    
    # Test 2.5: GET /api/purchase-orders (auth) → 200
    try:
        response = requests.get(
            f"{BASE_URL}/purchase-orders",
            headers=get_headers(auth_token),
            timeout=10
        )
        log_test(
            "GET /api/purchase-orders (auth) → 200",
            response.status_code == 200,
            f"Status: {response.status_code}, Count: {len(response.json()) if response.status_code == 200 else 'N/A'}",
            {"status_code": response.status_code}
        )
    except Exception as e:
        log_test("GET /api/purchase-orders exception", False, f"Exception: {str(e)}", {"error": str(e)})
    
    # Test 2.6: GET /api/followups (auth) → 200
    try:
        response = requests.get(
            f"{BASE_URL}/followups",
            headers=get_headers(auth_token),
            timeout=10
        )
        log_test(
            "GET /api/followups (auth) → 200",
            response.status_code == 200,
            f"Status: {response.status_code}, Count: {len(response.json()) if response.status_code == 200 else 'N/A'}",
            {"status_code": response.status_code}
        )
    except Exception as e:
        log_test("GET /api/followups exception", False, f"Exception: {str(e)}", {"error": str(e)})
    
    # Test 2.7: GET /api/products (auth) → 200, returns ~20 demo products
    try:
        response = requests.get(
            f"{BASE_URL}/products",
            headers=get_headers(auth_token),
            timeout=10
        )
        
        products_success = response.status_code == 200
        if products_success:
            data = response.json()
            # Handle both array and object with 'items' key
            if isinstance(data, list):
                products_count = len(data)
            elif isinstance(data, dict) and 'items' in data:
                products_count = len(data['items'])
            else:
                products_count = 0
            
            count_ok = 15 <= products_count <= 25
        else:
            products_count = 0
            count_ok = False
        
        log_test(
            "GET /api/products (auth) → 200, returns ~20 demo products",
            products_success and count_ok,
            f"Status: {response.status_code}, Count: {products_count}",
            {"status_code": response.status_code, "products_count": products_count}
        )
    except Exception as e:
        log_test("GET /api/products exception", False, f"Exception: {str(e)}", {"error": str(e)})
    
    # Test 2.8: GET /api/brands → 200
    try:
        response = requests.get(
            f"{BASE_URL}/brands",
            headers=get_headers(auth_token),
            timeout=10
        )
        log_test(
            "GET /api/brands → 200",
            response.status_code == 200,
            f"Status: {response.status_code}, Count: {len(response.json()) if response.status_code == 200 else 'N/A'}",
            {"status_code": response.status_code}
        )
    except Exception as e:
        log_test("GET /api/brands exception", False, f"Exception: {str(e)}", {"error": str(e)})
    
    # Test 2.9: GET /api/categories → 200
    try:
        response = requests.get(
            f"{BASE_URL}/categories",
            headers=get_headers(auth_token),
            timeout=10
        )
        log_test(
            "GET /api/categories → 200",
            response.status_code == 200,
            f"Status: {response.status_code}, Count: {len(response.json()) if response.status_code == 200 else 'N/A'}",
            {"status_code": response.status_code}
        )
    except Exception as e:
        log_test("GET /api/categories exception", False, f"Exception: {str(e)}", {"error": str(e)})
    
    # Test 2.10: Auth guard - GET /api/quotations without token → 401
    try:
        response = requests.get(
            f"{BASE_URL}/quotations",
            timeout=10
        )
        log_test(
            "Auth guard: GET /api/quotations without token → 401",
            response.status_code == 401,
            f"Status: {response.status_code}",
            {"status_code": response.status_code}
        )
    except Exception as e:
        log_test("Auth guard test exception", False, f"Exception: {str(e)}", {"error": str(e)})

# ============================================================================
# MAIN
# ============================================================================
def main():
    print("\n" + "="*80)
    print("BACKEND RECOVERY & HEALTH SYSTEM TEST")
    print("Testing new /api/health/system endpoint + smoke regression")
    print("="*80)
    
    test_health_system()
    test_smoke_regression()
    
    # Summary
    print("\n" + "="*80)
    print("TEST SUMMARY")
    print("="*80)
    
    total_tests = len(test_results)
    passed_tests = sum(1 for r in test_results if r["passed"])
    failed_tests = total_tests - passed_tests
    
    print(f"Total tests: {total_tests}")
    print(f"Passed: {passed_tests} ✅")
    print(f"Failed: {failed_tests} ❌")
    print(f"Success rate: {(passed_tests/total_tests*100):.1f}%")
    
    if failed_tests > 0:
        print("\nFailed tests:")
        for r in test_results:
            if not r["passed"]:
                print(f"  ❌ {r['test']}: {r['details']}")
    
    print("\n" + "="*80)

if __name__ == "__main__":
    main()
