#!/usr/bin/env python3
"""
Backend Smoke Test - Phase 1 UI Polish Backend Health Check
Tests the specific endpoints needed by Quotation Builder
"""
import os

import requests
import json
import sys

# Use the public endpoint (Kubernetes ingress)
BASE_URL = "https://buildcon-preview.preview.emergentagent.com"

def test_health():
    """Test /api/health endpoint"""
    print("\n=== Testing /api/health ===")
    try:
        response = requests.get(f"{BASE_URL}/api/health", timeout=10)
        print(f"Status: {response.status_code}")
        if response.status_code == 200:
            print(f"Response: {response.json()}")
            return True
        else:
            print(f"Response: {response.text[:200]}")
            return False
    except Exception as e:
        print(f"ERROR: {e}")
        return False

def test_auth_login():
    """Test auth login with owner@forge.app / [legacy credential removed]"""
    print("\n=== Testing POST /api/auth/login ===")
    try:
        response = requests.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": "owner@forge.app", "password": os.environ["FORGE_TEST_OWNER_PASSWORD"]},
            timeout=10
        )
        print(f"Status: {response.status_code}")
        if response.status_code == 200:
            data = response.json()
            print("Login successful (credential response omitted)")
            return data.get("access_token")
        else:
            print(f"Response: {response.text[:200]}")
            return None
    except Exception as e:
        print(f"ERROR: {e}")
        return None

def test_catalog_brands(token):
    """Test /api/catalog/brands"""
    print("\n=== Testing GET /api/catalog/brands ===")
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        response = requests.get(f"{BASE_URL}/api/catalog/brands", headers=headers, timeout=10)
        print(f"Status: {response.status_code}")
        if response.status_code == 200:
            data = response.json()
            print(f"Response: {json.dumps(data, indent=2)[:300]}")
            return True
        else:
            print(f"Response: {response.text[:200]}")
            return False
    except Exception as e:
        print(f"ERROR: {e}")
        return False

def test_products(token):
    """Test /api/products?limit=20"""
    print("\n=== Testing GET /api/products?limit=20 ===")
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        response = requests.get(f"{BASE_URL}/api/products?limit=20", headers=headers, timeout=10)
        print(f"Status: {response.status_code}")
        if response.status_code == 200:
            data = response.json()
            print(f"Total products: {data.get('total', 'N/A')}")
            print(f"Items returned: {len(data.get('items', []))}")
            return True
        else:
            print(f"Response: {response.text[:200]}")
            return False
    except Exception as e:
        print(f"ERROR: {e}")
        return False

def test_quotations(token):
    """Test quotation reference endpoints"""
    print("\n=== Testing GET /api/quotations ===")
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        response = requests.get(f"{BASE_URL}/api/quotations", headers=headers, timeout=10)
        print(f"Status: {response.status_code}")
        if response.status_code == 200:
            data = response.json()
            print(f"Quotations count: {len(data) if isinstance(data, list) else 'N/A'}")
            return True
        else:
            print(f"Response: {response.text[:200]}")
            return False
    except Exception as e:
        print(f"ERROR: {e}")
        return False

def main():
    print("=" * 80)
    print("BACKEND SMOKE TEST - Phase 1 UI Polish")
    print("=" * 80)
    print(f"Base URL: {BASE_URL}")
    
    results = {}
    
    # Test 1: Health endpoint
    results['health'] = test_health()
    
    # Test 2: Auth login
    token = test_auth_login()
    results['auth'] = token is not None
    
    # Test 3: Catalog brands
    results['brands'] = test_catalog_brands(token)
    
    # Test 4: Products
    results['products'] = test_products(token)
    
    # Test 5: Quotations
    results['quotations'] = test_quotations(token)
    
    # Summary
    print("\n" + "=" * 80)
    print("SUMMARY")
    print("=" * 80)
    for test_name, passed in results.items():
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"{test_name:20s}: {status}")
    
    total = len(results)
    passed = sum(results.values())
    print(f"\nTotal: {passed}/{total} tests passed")
    
    if passed == total:
        print("\n✅ All backend APIs are healthy and available")
        return 0
    else:
        print("\n❌ Backend has issues - see details above")
        return 1

if __name__ == "__main__":
    sys.exit(main())
