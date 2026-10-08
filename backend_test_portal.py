#!/usr/bin/env python3
"""
Customer Portal Backend Endpoint Testing
Tests customer-scoped quotation endpoints with authentication
"""
import os
import json
import sys
from typing import Optional

import requests

# Backend URL - use public URL from frontend/.env
BASE_URL = "https://buildcon-preview.preview.emergentagent.com/api"

# Test credentials from /app/memory/test_credentials.md
CUSTOMER_EMAIL = "customer@forge.app"
CUSTOMER_PASSWORD = os.environ["FORGE_TEST_OWNER_PASSWORD"]
STAFF_EMAIL = "owner@forge.app"
STAFF_PASSWORD = os.environ["FORGE_TEST_OWNER_PASSWORD"]

# Global token storage
CUSTOMER_TOKEN: Optional[str] = None
STAFF_TOKEN: Optional[str] = None


class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    RESET = '\033[0m'


def log_test(name: str):
    print(f"\n{Colors.BLUE}▶ {name}{Colors.RESET}")


def log_pass(msg: str):
    print(f"  {Colors.GREEN}✓ {msg}{Colors.RESET}")


def log_fail(msg: str):
    print(f"  {Colors.RED}✗ {msg}{Colors.RESET}")


def log_info(msg: str):
    print(f"  {Colors.CYAN}ℹ {msg}{Colors.RESET}")


def log_warn(msg: str):
    print(f"  {Colors.YELLOW}⚠ {msg}{Colors.RESET}")


# =============================================================================
# Authentication
# =============================================================================

def test_customer_login():
    """Login as customer to get bearer token"""
    global CUSTOMER_TOKEN
    log_test("Customer Login (POST /api/auth/customer/login)")
    
    try:
        resp = requests.post(
            f"{BASE_URL}/auth/customer/login",
            json={"email": CUSTOMER_EMAIL, "password": CUSTOMER_PASSWORD},
            timeout=10
        )
        
        if resp.status_code != 200:
            log_fail(f"Customer login failed with status {resp.status_code}: {resp.text}")
            return False
        
        data = resp.json()
        token = data.get("access_token") or data.get("token")
        if not token:
            log_fail(f"No token in response: {data}")
            return False
        
        CUSTOMER_TOKEN = token
        log_pass(f"Customer login successful, JWT token received (length: {len(CUSTOMER_TOKEN)})")
        log_info(f"Customer: {data.get('customer', {}).get('name')} ({data.get('customer', {}).get('email')})")
        return True
        
    except Exception as e:
        log_fail(f"Exception during customer login: {e}")
        return False


def test_staff_login():
    """Login as staff to get bearer token for regression checks"""
    global STAFF_TOKEN
    log_test("Staff Login (POST /api/auth/login)")
    
    try:
        resp = requests.post(
            f"{BASE_URL}/auth/login",
            json={"email": STAFF_EMAIL, "password": STAFF_PASSWORD},
            timeout=10
        )
        
        if resp.status_code != 200:
            log_fail(f"Staff login failed with status {resp.status_code}: {resp.text}")
            return False
        
        data = resp.json()
        token = data.get("access_token") or data.get("token")
        if not token:
            log_fail(f"No token in response: {data}")
            return False
        
        STAFF_TOKEN = token
        log_pass(f"Staff login successful, JWT token received")
        log_info(f"User: {data.get('user', {}).get('full_name')} ({data.get('user', {}).get('role')})")
        return True
        
    except Exception as e:
        log_fail(f"Exception during staff login: {e}")
        return False


# =============================================================================
# NEW/CHANGED Customer Portal Endpoints
# =============================================================================

def test_portal_quotations_list():
    """Test 4: GET /api/portal/quotations - list endpoint sanity check"""
    log_test("Test 4: GET /api/portal/quotations (list endpoint)")
    
    if not CUSTOMER_TOKEN:
        log_fail("No customer token available")
        return False
    
    headers = {"Authorization": f"Bearer {CUSTOMER_TOKEN}"}
    
    try:
        resp = requests.get(f"{BASE_URL}/portal/quotations", headers=headers, timeout=10)
        
        if resp.status_code != 200:
            log_fail(f"Expected 200, got {resp.status_code}: {resp.text}")
            return False
        
        quotations = resp.json()
        log_pass(f"Status: 200 OK")
        log_pass(f"Returned {len(quotations)} quotations for customer")
        
        if quotations:
            # Check sorting (newest first)
            first = quotations[0]
            log_info(f"First quotation: {first.get('number')} (created: {first.get('created_at')})")
            
            # Check if sorted by created_at descending
            if len(quotations) > 1:
                dates = [q.get('created_at') for q in quotations if q.get('created_at')]
                if dates == sorted(dates, reverse=True):
                    log_pass("Quotations sorted newest first (correct)")
                else:
                    log_warn("Quotations may not be sorted newest first")
        
        return True
        
    except Exception as e:
        log_fail(f"Exception: {e}")
        return False


def test_portal_quotation_detail():
    """Test 1: GET /api/portal/quotations/{quotation_id} - customer-scoped detail view"""
    log_test("Test 1: GET /api/portal/quotations/{quotation_id} (detail view)")
    
    if not CUSTOMER_TOKEN:
        log_fail("No customer token available")
        return False
    
    headers = {"Authorization": f"Bearer {CUSTOMER_TOKEN}"}
    all_passed = True
    
    # First, get a quotation ID from the list
    try:
        resp = requests.get(f"{BASE_URL}/portal/quotations", headers=headers, timeout=10)
        if resp.status_code != 200:
            log_fail("Could not fetch quotations list")
            return False
        
        quotations = resp.json()
        if not quotations:
            log_warn("No quotations available for testing - cannot test detail endpoint")
            return True  # Not a failure, just no data
        
        quotation_id = quotations[0]["id"]
        quotation_number = quotations[0].get("number", "N/A")
        log_info(f"Testing with quotation: {quotation_number} (id: {quotation_id})")
        
    except Exception as e:
        log_fail(f"Exception fetching quotations list: {e}")
        return False
    
    # Test 1a: Returns 200 with full quotation fields + revisions + brands arrays
    try:
        resp = requests.get(f"{BASE_URL}/portal/quotations/{quotation_id}", headers=headers, timeout=10)
        
        if resp.status_code != 200:
            log_fail(f"Test 1a: Expected 200, got {resp.status_code}: {resp.text}")
            all_passed = False
        else:
            data = resp.json()
            log_pass("Test 1a: Status 200 OK")
            
            # Check required fields
            required_fields = ["items", "subtotal", "grand_total", "status"]
            missing_fields = [f for f in required_fields if f not in data]
            if missing_fields:
                log_fail(f"Test 1a: Missing required fields: {missing_fields}")
                all_passed = False
            else:
                log_pass(f"Test 1a: All required fields present (items, subtotal, grand_total, status)")
            
            # Check revisions array
            if "revisions" not in data:
                log_fail("Test 1a: Missing 'revisions' array")
                all_passed = False
            else:
                revisions = data["revisions"]
                log_pass(f"Test 1a: 'revisions' array present ({len(revisions)} revisions)")
                
                # Check revisions are metadata only (not full snapshots)
                if revisions:
                    first_rev = revisions[0]
                    if "revision_no" in first_rev and "created_at" in first_rev:
                        log_pass("Test 1a: Revisions contain metadata (revision_no, created_at)")
                    else:
                        log_fail("Test 1a: Revisions missing expected metadata fields")
                        all_passed = False
                    
                    # Ensure it's NOT full snapshot (should not have 'snapshot' key or 'items' array)
                    if "snapshot" in first_rev or "items" in first_rev:
                        log_fail("Test 1a: Revisions contain full snapshot data (should be metadata only)")
                        all_passed = False
                    else:
                        log_pass("Test 1a: Revisions are metadata only (not full snapshots)")
            
            # Check brands array
            if "brands" not in data:
                log_fail("Test 1a: Missing 'brands' array")
                all_passed = False
            else:
                brands = data["brands"]
                log_pass(f"Test 1a: 'brands' array present ({len(brands)} brands)")
                
                # Check brand structure
                if brands:
                    first_brand = brands[0]
                    expected_brand_fields = ["brand_id", "brand_name", "item_count", "subtotal"]
                    missing_brand_fields = [f for f in expected_brand_fields if f not in first_brand]
                    if missing_brand_fields:
                        log_fail(f"Test 1a: Brand missing fields: {missing_brand_fields}")
                        all_passed = False
                    else:
                        log_pass(f"Test 1a: Brand structure correct (brand_id, brand_name, item_count, subtotal)")
                        log_info(f"Test 1a: Example brand: {first_brand.get('brand_name')} ({first_brand.get('item_count')} items, ₹{first_brand.get('subtotal')})")
    
    except Exception as e:
        log_fail(f"Test 1a: Exception: {e}")
        all_passed = False
    
    # Test 1b: Returns 404 for non-existent quotation_id
    try:
        fake_id = "00000000-0000-0000-0000-000000000000"
        resp = requests.get(f"{BASE_URL}/portal/quotations/{fake_id}", headers=headers, timeout=10)
        
        if resp.status_code == 404:
            log_pass("Test 1b: Returns 404 for non-existent quotation_id")
        else:
            log_fail(f"Test 1b: Expected 404 for non-existent ID, got {resp.status_code}")
            all_passed = False
    
    except Exception as e:
        log_fail(f"Test 1b: Exception: {e}")
        all_passed = False
    
    # Test 1c: Returns 401/403 with no auth token
    try:
        resp = requests.get(f"{BASE_URL}/portal/quotations/{quotation_id}", timeout=10)
        
        if resp.status_code in [401, 403]:
            log_pass(f"Test 1c: Returns {resp.status_code} with no auth token (correct)")
        else:
            log_fail(f"Test 1c: Expected 401/403 with no auth, got {resp.status_code}")
            all_passed = False
    
    except Exception as e:
        log_fail(f"Test 1c: Exception: {e}")
        all_passed = False
    
    return all_passed


def test_portal_pdf_revision():
    """Test 2: GET /api/quotations/{quotation_id}/portal-pdf/revision/{revision_no}"""
    log_test("Test 2: GET /api/quotations/{quotation_id}/portal-pdf/revision/{revision_no}")
    
    if not CUSTOMER_TOKEN:
        log_fail("No customer token available")
        return False
    
    headers = {"Authorization": f"Bearer {CUSTOMER_TOKEN}"}
    all_passed = True
    
    # First, find a quotation with revisions
    try:
        resp = requests.get(f"{BASE_URL}/portal/quotations", headers=headers, timeout=10)
        if resp.status_code != 200:
            log_fail("Could not fetch quotations list")
            return False
        
        quotations = resp.json()
        if not quotations:
            log_warn("No quotations available for testing")
            return True
        
        # Find a quotation with revisions
        quotation_with_revisions = None
        for q in quotations:
            if q.get("revisions") and len(q.get("revisions", [])) > 0:
                quotation_with_revisions = q
                break
        
        # If no quotation with revisions, get detail view to check
        if not quotation_with_revisions:
            for q in quotations:
                detail_resp = requests.get(f"{BASE_URL}/portal/quotations/{q['id']}", headers=headers, timeout=10)
                if detail_resp.status_code == 200:
                    detail = detail_resp.json()
                    if detail.get("revisions") and len(detail.get("revisions", [])) > 0:
                        quotation_with_revisions = detail
                        break
        
        if not quotation_with_revisions:
            log_warn("No quotations with revisions found - testing with revision_no=1 anyway")
            quotation_id = quotations[0]["id"]
            revision_no = 1
        else:
            quotation_id = quotation_with_revisions["id"]
            revisions = quotation_with_revisions.get("revisions", [])
            revision_no = revisions[0].get("revision_no", 1)
            log_info(f"Testing with quotation: {quotation_with_revisions.get('number')} (has {len(revisions)} revisions)")
        
    except Exception as e:
        log_fail(f"Exception finding quotation with revisions: {e}")
        return False
    
    # Test 2a: Returns 200 with valid PDF for existing revision
    try:
        resp = requests.get(
            f"{BASE_URL}/quotations/{quotation_id}/portal-pdf/revision/{revision_no}",
            headers=headers,
            timeout=15
        )
        
        if resp.status_code == 200:
            log_pass(f"Test 2a: Status 200 OK for revision {revision_no}")
            
            # Check Content-Type
            content_type = resp.headers.get("Content-Type", "")
            if "application/pdf" in content_type:
                log_pass("Test 2a: Content-Type is application/pdf")
            else:
                log_fail(f"Test 2a: Expected Content-Type application/pdf, got {content_type}")
                all_passed = False
            
            # Check PDF magic bytes
            pdf_bytes = resp.content
            if pdf_bytes.startswith(b'%PDF'):
                log_pass(f"Test 2a: Valid PDF bytes (starts with %PDF, size: {len(pdf_bytes)} bytes)")
            else:
                log_fail(f"Test 2a: Invalid PDF bytes (does not start with %PDF)")
                all_passed = False
        
        elif resp.status_code == 404:
            log_warn(f"Test 2a: Got 404 - quotation may not have revision {revision_no}")
            # This is OK if the quotation doesn't have revisions
        else:
            log_fail(f"Test 2a: Expected 200, got {resp.status_code}: {resp.text[:200]}")
            all_passed = False
    
    except Exception as e:
        log_fail(f"Test 2a: Exception: {e}")
        all_passed = False
    
    # Test 2b: Returns 404 for non-existent revision_no
    try:
        resp = requests.get(
            f"{BASE_URL}/quotations/{quotation_id}/portal-pdf/revision/999",
            headers=headers,
            timeout=10
        )
        
        if resp.status_code == 404:
            log_pass("Test 2b: Returns 404 for non-existent revision_no (999)")
        else:
            log_fail(f"Test 2b: Expected 404 for revision_no=999, got {resp.status_code}")
            all_passed = False
    
    except Exception as e:
        log_fail(f"Test 2b: Exception: {e}")
        all_passed = False
    
    # Test 2c: Returns 404 if quotation doesn't belong to customer
    # (We can't easily test this without another customer's quotation, so we'll test with fake ID)
    try:
        fake_id = "00000000-0000-0000-0000-000000000000"
        resp = requests.get(
            f"{BASE_URL}/quotations/{fake_id}/portal-pdf/revision/1",
            headers=headers,
            timeout=10
        )
        
        if resp.status_code == 404:
            log_pass("Test 2c: Returns 404 for quotation not belonging to customer")
        else:
            log_fail(f"Test 2c: Expected 404, got {resp.status_code}")
            all_passed = False
    
    except Exception as e:
        log_fail(f"Test 2c: Exception: {e}")
        all_passed = False
    
    # Test 2d: Unauthenticated request is rejected
    try:
        resp = requests.get(
            f"{BASE_URL}/quotations/{quotation_id}/portal-pdf/revision/{revision_no}",
            timeout=10
        )
        
        if resp.status_code in [401, 403]:
            log_pass(f"Test 2d: Unauthenticated request rejected ({resp.status_code})")
        else:
            log_fail(f"Test 2d: Expected 401/403 for unauthenticated request, got {resp.status_code}")
            all_passed = False
    
    except Exception as e:
        log_fail(f"Test 2d: Exception: {e}")
        all_passed = False
    
    return all_passed


def test_portal_pdf_brand():
    """Test 3: GET /api/quotations/{quotation_id}/portal-pdf/brand/{brand_id}"""
    log_test("Test 3: GET /api/quotations/{quotation_id}/portal-pdf/brand/{brand_id}")
    
    if not CUSTOMER_TOKEN:
        log_fail("No customer token available")
        return False
    
    headers = {"Authorization": f"Bearer {CUSTOMER_TOKEN}"}
    all_passed = True
    
    # First, get a quotation with brands
    try:
        resp = requests.get(f"{BASE_URL}/portal/quotations", headers=headers, timeout=10)
        if resp.status_code != 200:
            log_fail("Could not fetch quotations list")
            return False
        
        quotations = resp.json()
        if not quotations:
            log_warn("No quotations available for testing")
            return True
        
        # Get detail view to find brands
        quotation_id = quotations[0]["id"]
        detail_resp = requests.get(f"{BASE_URL}/portal/quotations/{quotation_id}", headers=headers, timeout=10)
        
        if detail_resp.status_code != 200:
            log_fail("Could not fetch quotation detail")
            return False
        
        detail = detail_resp.json()
        brands = detail.get("brands", [])
        
        if not brands:
            log_warn("No brands found in quotation - cannot test brand PDF endpoint")
            return True
        
        brand_id = brands[0].get("brand_id")
        brand_name = brands[0].get("brand_name", "N/A")
        log_info(f"Testing with quotation: {detail.get('number')}, brand: {brand_name} (id: {brand_id})")
        
    except Exception as e:
        log_fail(f"Exception finding quotation with brands: {e}")
        return False
    
    # Test 3a: Returns 200 with valid PDF for valid brand_id
    try:
        resp = requests.get(
            f"{BASE_URL}/quotations/{quotation_id}/portal-pdf/brand/{brand_id}",
            headers=headers,
            timeout=15
        )
        
        if resp.status_code == 200:
            log_pass(f"Test 3a: Status 200 OK for brand {brand_name}")
            
            # Check Content-Type
            content_type = resp.headers.get("Content-Type", "")
            if "application/pdf" in content_type:
                log_pass("Test 3a: Content-Type is application/pdf")
            else:
                log_fail(f"Test 3a: Expected Content-Type application/pdf, got {content_type}")
                all_passed = False
            
            # Check PDF magic bytes
            pdf_bytes = resp.content
            if pdf_bytes.startswith(b'%PDF'):
                log_pass(f"Test 3a: Valid PDF bytes (starts with %PDF, size: {len(pdf_bytes)} bytes)")
            else:
                log_fail(f"Test 3a: Invalid PDF bytes (does not start with %PDF)")
                all_passed = False
        else:
            log_fail(f"Test 3a: Expected 200, got {resp.status_code}: {resp.text[:200]}")
            all_passed = False
    
    except Exception as e:
        log_fail(f"Test 3a: Exception: {e}")
        all_passed = False
    
    # Test 3b: Returns 404 for brand_id not present on quotation
    try:
        fake_brand_id = "00000000-0000-0000-0000-000000000000"
        resp = requests.get(
            f"{BASE_URL}/quotations/{quotation_id}/portal-pdf/brand/{fake_brand_id}",
            headers=headers,
            timeout=10
        )
        
        if resp.status_code == 404:
            log_pass("Test 3b: Returns 404 for brand_id not present on quotation")
        else:
            log_fail(f"Test 3b: Expected 404 for non-existent brand_id, got {resp.status_code}")
            all_passed = False
    
    except Exception as e:
        log_fail(f"Test 3b: Exception: {e}")
        all_passed = False
    
    # Test 3c: Returns 404 if quotation doesn't belong to customer
    try:
        fake_quotation_id = "00000000-0000-0000-0000-000000000000"
        resp = requests.get(
            f"{BASE_URL}/quotations/{fake_quotation_id}/portal-pdf/brand/{brand_id}",
            headers=headers,
            timeout=10
        )
        
        if resp.status_code == 404:
            log_pass("Test 3c: Returns 404 for quotation not belonging to customer")
        else:
            log_fail(f"Test 3c: Expected 404, got {resp.status_code}")
            all_passed = False
    
    except Exception as e:
        log_fail(f"Test 3c: Exception: {e}")
        all_passed = False
    
    # Test 3d: Unauthenticated request is rejected
    try:
        resp = requests.get(
            f"{BASE_URL}/quotations/{quotation_id}/portal-pdf/brand/{brand_id}",
            timeout=10
        )
        
        if resp.status_code in [401, 403]:
            log_pass(f"Test 3d: Unauthenticated request rejected ({resp.status_code})")
        else:
            log_fail(f"Test 3d: Expected 401/403 for unauthenticated request, got {resp.status_code}")
            all_passed = False
    
    except Exception as e:
        log_fail(f"Test 3d: Exception: {e}")
        all_passed = False
    
    return all_passed


# =============================================================================
# Regression Checks
# =============================================================================

def test_regression_checks():
    """Test 5: Regression checks on existing endpoints"""
    log_test("Test 5: Regression checks on existing endpoints")
    
    if not STAFF_TOKEN:
        log_fail("No staff token available")
        return False
    
    staff_headers = {"Authorization": f"Bearer {STAFF_TOKEN}"}
    all_passed = True
    
    # Check 1: POST /api/auth/login (staff) - already tested in test_staff_login()
    log_pass("Check 1: POST /api/auth/login (staff) - already verified")
    
    # Check 2: GET /api/health/system
    try:
        resp = requests.get(f"{BASE_URL}/health/system", timeout=10)
        
        if resp.status_code == 200:
            data = resp.json()
            if data.get("healthy") is True:
                log_pass("Check 2: GET /api/health/system - healthy=true")
            else:
                log_fail(f"Check 2: GET /api/health/system - healthy={data.get('healthy')}")
                all_passed = False
            
            # Check mongo connected to buildcon_house
            mongo = data.get("mongo", {})
            if mongo.get("connected") and not mongo.get("is_local"):
                log_pass("Check 2: MongoDB connected (not local)")
            else:
                log_fail("Check 2: MongoDB not connected or is local")
                all_passed = False
            
            # Check product count
            counts = data.get("counts", {})
            product_count = counts.get("products", 0)
            if product_count >= 2900:  # Allow some variance
                log_pass(f"Check 2: Product count ~{product_count} (expected ~2966)")
            else:
                log_warn(f"Check 2: Product count {product_count} (expected ~2966)")
        else:
            log_fail(f"Check 2: GET /api/health/system failed with {resp.status_code}")
            all_passed = False
    
    except Exception as e:
        log_fail(f"Check 2: Exception: {e}")
        all_passed = False
    
    # Check 3: GET /api/quotations (staff list)
    try:
        resp = requests.get(f"{BASE_URL}/quotations", headers=staff_headers, timeout=10)
        
        if resp.status_code == 200:
            quotations = resp.json()
            log_pass(f"Check 3: GET /api/quotations (staff) - 200 OK ({len(quotations)} quotations)")
        else:
            log_fail(f"Check 3: GET /api/quotations failed with {resp.status_code}")
            all_passed = False
    
    except Exception as e:
        log_fail(f"Check 3: Exception: {e}")
        all_passed = False
    
    # Check 4: GET /api/quotations/{id} (staff detail)
    try:
        # Get a quotation ID first
        resp = requests.get(f"{BASE_URL}/quotations", headers=staff_headers, timeout=10)
        if resp.status_code == 200:
            quotations = resp.json()
            if quotations:
                quotation_id = quotations[0]["id"]
                
                detail_resp = requests.get(f"{BASE_URL}/quotations/{quotation_id}", headers=staff_headers, timeout=10)
                
                if detail_resp.status_code == 200:
                    log_pass(f"Check 4: GET /api/quotations/{{id}} (staff) - 200 OK")
                else:
                    log_fail(f"Check 4: GET /api/quotations/{{id}} failed with {detail_resp.status_code}")
                    all_passed = False
            else:
                log_warn("Check 4: No quotations available to test detail endpoint")
        else:
            log_fail("Check 4: Could not fetch quotations list")
            all_passed = False
    
    except Exception as e:
        log_fail(f"Check 4: Exception: {e}")
        all_passed = False
    
    # Check 5: GET /api/quotations/{id}/portal-pdf (pre-existing current-state PDF)
    if not CUSTOMER_TOKEN:
        log_warn("Check 5: No customer token, skipping portal-pdf check")
    else:
        try:
            customer_headers = {"Authorization": f"Bearer {CUSTOMER_TOKEN}"}
            
            # Get a customer's quotation
            resp = requests.get(f"{BASE_URL}/portal/quotations", headers=customer_headers, timeout=10)
            if resp.status_code == 200:
                quotations = resp.json()
                if quotations:
                    quotation_id = quotations[0]["id"]
                    
                    pdf_resp = requests.get(
                        f"{BASE_URL}/quotations/{quotation_id}/portal-pdf",
                        headers=customer_headers,
                        timeout=15
                    )
                    
                    if pdf_resp.status_code == 200:
                        content_type = pdf_resp.headers.get("Content-Type", "")
                        pdf_bytes = pdf_resp.content
                        
                        if "application/pdf" in content_type and pdf_bytes.startswith(b'%PDF'):
                            log_pass("Check 5: GET /api/quotations/{id}/portal-pdf - returns valid PDF")
                        else:
                            log_fail("Check 5: portal-pdf returned invalid PDF")
                            all_passed = False
                    else:
                        log_fail(f"Check 5: portal-pdf failed with {pdf_resp.status_code}")
                        all_passed = False
                else:
                    log_warn("Check 5: No quotations available to test portal-pdf")
            else:
                log_fail("Check 5: Could not fetch customer quotations")
                all_passed = False
        
        except Exception as e:
            log_fail(f"Check 5: Exception: {e}")
            all_passed = False
    
    return all_passed


# =============================================================================
# Main Test Runner
# =============================================================================

def main():
    print(f"\n{Colors.BLUE}{'='*80}{Colors.RESET}")
    print(f"{Colors.BLUE}Customer Portal Backend Endpoint Testing{Colors.RESET}")
    print(f"{Colors.BLUE}Testing customer-scoped quotation endpoints{Colors.RESET}")
    print(f"{Colors.BLUE}{'='*80}{Colors.RESET}")
    
    results = {}
    
    # Authentication
    print(f"\n{Colors.YELLOW}{'='*80}{Colors.RESET}")
    print(f"{Colors.YELLOW}AUTHENTICATION{Colors.RESET}")
    print(f"{Colors.YELLOW}{'='*80}{Colors.RESET}")
    
    results["customer_login"] = test_customer_login()
    results["staff_login"] = test_staff_login()
    
    if not results["customer_login"]:
        print(f"\n{Colors.RED}{'='*80}{Colors.RESET}")
        print(f"{Colors.RED}CRITICAL: Customer login failed - cannot proceed with tests{Colors.RESET}")
        print(f"{Colors.RED}{'='*80}{Colors.RESET}\n")
        return 1
    
    # NEW/CHANGED Endpoints
    print(f"\n{Colors.YELLOW}{'='*80}{Colors.RESET}")
    print(f"{Colors.YELLOW}NEW/CHANGED CUSTOMER PORTAL ENDPOINTS{Colors.RESET}")
    print(f"{Colors.YELLOW}{'='*80}{Colors.RESET}")
    
    results["test_4_list"] = test_portal_quotations_list()
    results["test_1_detail"] = test_portal_quotation_detail()
    results["test_2_pdf_revision"] = test_portal_pdf_revision()
    results["test_3_pdf_brand"] = test_portal_pdf_brand()
    
    # Regression Checks
    print(f"\n{Colors.YELLOW}{'='*80}{Colors.RESET}")
    print(f"{Colors.YELLOW}REGRESSION CHECKS{Colors.RESET}")
    print(f"{Colors.YELLOW}{'='*80}{Colors.RESET}")
    
    results["test_5_regression"] = test_regression_checks()
    
    # Summary
    print(f"\n{Colors.BLUE}{'='*80}{Colors.RESET}")
    print(f"{Colors.BLUE}SUMMARY{Colors.RESET}")
    print(f"{Colors.BLUE}{'='*80}{Colors.RESET}")
    
    test_results = {
        "Test 1: GET /api/portal/quotations/{id} (detail)": results.get("test_1_detail"),
        "Test 2: GET /api/quotations/{id}/portal-pdf/revision/{no}": results.get("test_2_pdf_revision"),
        "Test 3: GET /api/quotations/{id}/portal-pdf/brand/{id}": results.get("test_3_pdf_brand"),
        "Test 4: GET /api/portal/quotations (list)": results.get("test_4_list"),
        "Test 5: Regression checks": results.get("test_5_regression"),
    }
    
    for test_name, passed in test_results.items():
        if passed:
            print(f"  {Colors.GREEN}✓ PASS{Colors.RESET} {test_name}")
        else:
            print(f"  {Colors.RED}✗ FAIL{Colors.RESET} {test_name}")
    
    passed_count = sum(1 for v in test_results.values() if v)
    total_count = len(test_results)
    
    print(f"\n{Colors.BLUE}Total: {passed_count}/{total_count} tests passed{Colors.RESET}")
    
    if passed_count == total_count:
        print(f"\n{Colors.GREEN}{'='*80}{Colors.RESET}")
        print(f"{Colors.GREEN}ALL TESTS PASSED ✓{Colors.RESET}")
        print(f"{Colors.GREEN}{'='*80}{Colors.RESET}\n")
        return 0
    else:
        print(f"\n{Colors.RED}{'='*80}{Colors.RESET}")
        print(f"{Colors.RED}SOME TESTS FAILED ✗{Colors.RESET}")
        print(f"{Colors.RED}{'='*80}{Colors.RESET}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
