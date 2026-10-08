#!/usr/bin/env python3
"""
Backend Settings Endpoints Testing
Tests new Settings backend endpoints for Forge/BuildCon House app
"""
import os
import base64
import json
import sys
from typing import Any, Dict, Optional

import requests

# Backend URL (internal container access)
BASE_URL = "http://localhost:8001/api"

# Test credentials from /app/memory/test_credentials.md
OWNER_EMAIL = "owner@forge.app"
OWNER_PASSWORD = os.environ["FORGE_TEST_OWNER_PASSWORD"]

# Global token storage
AUTH_TOKEN: Optional[str] = None
OWNER_USER_ID: Optional[str] = None


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


# =============================================================================
# Setup: Login
# =============================================================================

def test_login():
    """Login with owner@forge.app/[legacy credential removed] to get auth token"""
    global AUTH_TOKEN, OWNER_USER_ID
    log_test("Setup: Login with owner@forge.app / [legacy credential removed]")
    
    try:
        resp = requests.post(
            f"{BASE_URL}/auth/login",
            json={"email": OWNER_EMAIL, "password": OWNER_PASSWORD},
            timeout=10
        )
        
        if resp.status_code != 200:
            log_fail(f"Login failed with status {resp.status_code}: {resp.text}")
            return False
        
        data = resp.json()
        token = data.get("access_token") or data.get("token")
        if not token:
            log_fail(f"No token in response: {data}")
            return False
        
        AUTH_TOKEN = token
        user = data.get("user", {})
        OWNER_USER_ID = user.get("id")
        log_pass(f"Login successful, JWT token received")
        log_pass(f"User: {user.get('full_name')} ({user.get('email')}), Role: {user.get('role')}")
        return True
        
    except Exception as e:
        log_fail(f"Exception during login: {e}")
        return False


# =============================================================================
# Test 1: POST /api/auth/change-password
# =============================================================================

def test_change_password():
    """Test password change endpoint with various scenarios"""
    log_test("Test 1: POST /api/auth/change-password")
    
    if not AUTH_TOKEN:
        log_fail("No auth token available")
        return False
    
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
    all_passed = True
    
    # Test 1a: Wrong current password should return 401
    try:
        resp = requests.post(
            f"{BASE_URL}/auth/change-password",
            headers=headers,
            json={"current_password": "WrongPassword123", "new_password": "NewPassword123"},
            timeout=10
        )
        
        if resp.status_code == 401:
            log_pass("1a. Wrong current password: 401 (correct)")
        else:
            log_fail(f"1a. Wrong current password: expected 401, got {resp.status_code}")
            all_passed = False
    except Exception as e:
        log_fail(f"1a. Exception: {e}")
        all_passed = False
    
    # Test 1b: Correct current password, change to new password
    try:
        new_password = "TempPassword2026"
        resp = requests.post(
            f"{BASE_URL}/auth/change-password",
            headers=headers,
            json={"current_password": OWNER_PASSWORD, "new_password": new_password},
            timeout=10
        )
        
        if resp.status_code == 200:
            data = resp.json()
            if data.get("changed") is True:
                log_pass(f"1b. Password change with correct current password: 200 OK, changed=true")
                
                # Verify new password works
                login_resp = requests.post(
                    f"{BASE_URL}/auth/login",
                    json={"email": OWNER_EMAIL, "password": new_password},
                    timeout=10
                )
                
                if login_resp.status_code == 200:
                    log_pass("1b. New password works for login")
                else:
                    log_fail(f"1b. New password login failed: {login_resp.status_code}")
                    all_passed = False
                
                # Verify old password no longer works
                old_login_resp = requests.post(
                    f"{BASE_URL}/auth/login",
                    json={"email": OWNER_EMAIL, "password": OWNER_PASSWORD},
                    timeout=10
                )
                
                if old_login_resp.status_code == 401:
                    log_pass("1b. Old password no longer works (401)")
                else:
                    log_fail(f"1b. Old password still works: {old_login_resp.status_code}")
                    all_passed = False
            else:
                log_fail(f"1b. Response missing 'changed: true': {data}")
                all_passed = False
        else:
            log_fail(f"1b. Password change failed: {resp.status_code}, {resp.text}")
            all_passed = False
    except Exception as e:
        log_fail(f"1b. Exception: {e}")
        all_passed = False
    
    # Test 1c: Change password back to original ([legacy credential removed])
    try:
        # Login with new password to get fresh token
        login_resp = requests.post(
            f"{BASE_URL}/auth/login",
            json={"email": OWNER_EMAIL, "password": new_password},
            timeout=10
        )
        
        if login_resp.status_code == 200:
            new_token = login_resp.json().get("access_token")
            headers_new = {"Authorization": f"Bearer {new_token}"}
            
            resp = requests.post(
                f"{BASE_URL}/auth/change-password",
                headers=headers_new,
                json={"current_password": new_password, "new_password": OWNER_PASSWORD},
                timeout=10
            )
            
            if resp.status_code == 200 and resp.json().get("changed") is True:
                log_pass(f"1c. Password changed back to [legacy credential removed] successfully")
                
                # Verify original password works again
                verify_resp = requests.post(
                    f"{BASE_URL}/auth/login",
                    json={"email": OWNER_EMAIL, "password": OWNER_PASSWORD},
                    timeout=10
                )
                
                if verify_resp.status_code == 200:
                    log_pass("1c. Original password ([legacy credential removed]) works again")
                else:
                    log_fail(f"1c. Original password doesn't work: {verify_resp.status_code}")
                    all_passed = False
            else:
                log_fail(f"1c. Failed to change password back: {resp.status_code}")
                all_passed = False
        else:
            log_fail(f"1c. Could not login with new password: {login_resp.status_code}")
            all_passed = False
    except Exception as e:
        log_fail(f"1c. Exception: {e}")
        all_passed = False
    
    # Test 1d: No auth token should return 401/403
    try:
        resp = requests.post(
            f"{BASE_URL}/auth/change-password",
            json={"current_password": OWNER_PASSWORD, "new_password": "NewPassword123"},
            timeout=10
        )
        
        if resp.status_code in [401, 403]:
            log_pass(f"1d. No auth token: {resp.status_code} (correct)")
        else:
            log_fail(f"1d. No auth token: expected 401/403, got {resp.status_code}")
            all_passed = False
    except Exception as e:
        log_fail(f"1d. Exception: {e}")
        all_passed = False
    
    return all_passed


# =============================================================================
# Test 2: GET/PUT /api/settings/company
# =============================================================================

def test_company_settings():
    """Test company settings endpoints"""
    log_test("Test 2: GET/PUT /api/settings/company")
    
    if not AUTH_TOKEN:
        log_fail("No auth token available")
        return False
    
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
    all_passed = True
    
    # Test 2a: GET should work for any authenticated staff
    try:
        resp = requests.get(f"{BASE_URL}/settings/company", headers=headers, timeout=10)
        
        if resp.status_code == 200:
            data = resp.json()
            log_pass("2a. GET /api/settings/company: 200 OK")
            
            # Verify defaults
            expected_defaults = {
                "name": "BuildCon House",
                "tagline": "One Destination. Infinite Possibilities.",
                "phone": "+91 99099 06652",
                "email": "buildconhouse10@gmail.com"
            }
            
            defaults_match = all(data.get(k) == v for k, v in expected_defaults.items())
            if defaults_match:
                log_pass("2a. Default values match expected")
            else:
                log_info(f"2a. Current values: {json.dumps(data, indent=2)}")
        else:
            log_fail(f"2a. GET failed: {resp.status_code}")
            all_passed = False
    except Exception as e:
        log_fail(f"2a. Exception: {e}")
        all_passed = False
    
    # Test 2b: PUT should require role >= admin (owner should succeed)
    try:
        test_data = {
            "name": "Test Company Name",
            "tagline": "Test Tagline",
            "phone": "+91 12345 67890",
            "email": "test@example.com"
        }
        
        resp = requests.put(
            f"{BASE_URL}/settings/company",
            headers=headers,
            json=test_data,
            timeout=10
        )
        
        if resp.status_code == 200:
            data = resp.json()
            log_pass("2b. PUT /api/settings/company (owner role): 200 OK")
            
            # Verify updated values
            if all(data.get(k) == v for k, v in test_data.items()):
                log_pass("2b. Updated values match")
            else:
                log_fail(f"2b. Updated values don't match: {data}")
                all_passed = False
            
            # Verify updated_at and updated_by fields
            if data.get("updated_at") and data.get("updated_by"):
                log_pass(f"2b. updated_at and updated_by fields present")
            else:
                log_fail(f"2b. Missing updated_at or updated_by fields")
                all_passed = False
        else:
            log_fail(f"2b. PUT failed: {resp.status_code}, {resp.text}")
            all_passed = False
    except Exception as e:
        log_fail(f"2b. Exception: {e}")
        all_passed = False
    
    # Test 2c: GET should reflect new values
    try:
        resp = requests.get(f"{BASE_URL}/settings/company", headers=headers, timeout=10)
        
        if resp.status_code == 200:
            data = resp.json()
            if data.get("name") == "Test Company Name":
                log_pass("2c. GET reflects updated values")
            else:
                log_fail(f"2c. GET doesn't reflect updates: {data}")
                all_passed = False
        else:
            log_fail(f"2c. GET failed: {resp.status_code}")
            all_passed = False
    except Exception as e:
        log_fail(f"2c. Exception: {e}")
        all_passed = False
    
    # Test 2d: Revert to original defaults
    try:
        default_data = {
            "name": "BuildCon House",
            "tagline": "One Destination. Infinite Possibilities.",
            "phone": "+91 99099 06652",
            "email": "buildconhouse10@gmail.com"
        }
        
        resp = requests.put(
            f"{BASE_URL}/settings/company",
            headers=headers,
            json=default_data,
            timeout=10
        )
        
        if resp.status_code == 200:
            log_pass("2d. Reverted to original defaults successfully")
        else:
            log_fail(f"2d. Failed to revert: {resp.status_code}")
            all_passed = False
    except Exception as e:
        log_fail(f"2d. Exception: {e}")
        all_passed = False
    
    return all_passed


# =============================================================================
# Test 3: GET/PUT /api/settings/pdf
# =============================================================================

def test_pdf_settings():
    """Test PDF settings endpoints"""
    log_test("Test 3: GET/PUT /api/settings/pdf")
    
    if not AUTH_TOKEN:
        log_fail("No auth token available")
        return False
    
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
    all_passed = True
    
    # Test 3a: GET should work for any authenticated staff
    try:
        resp = requests.get(f"{BASE_URL}/settings/pdf", headers=headers, timeout=10)
        
        if resp.status_code == 200:
            data = resp.json()
            log_pass("3a. GET /api/settings/pdf: 200 OK")
            
            # Verify defaults
            expected_defaults = {
                "footer_company_name": "Buildcon House",
                "footer_phone": "+91 99099 06652",
                "footer_email": "buildconhouse10@gmail.com",
                "footer_tagline": "One Destination. Infinite Possibilities.",
                "show_watermark": True
            }
            
            defaults_match = all(data.get(k) == v for k, v in expected_defaults.items())
            if defaults_match:
                log_pass("3a. Default values match expected")
            else:
                log_info(f"3a. Current values: {json.dumps(data, indent=2)}")
        else:
            log_fail(f"3a. GET failed: {resp.status_code}")
            all_passed = False
    except Exception as e:
        log_fail(f"3a. Exception: {e}")
        all_passed = False
    
    # Test 3b: PUT should require role >= admin (owner should succeed)
    try:
        test_data = {
            "footer_company_name": "Test PDF Company",
            "footer_phone": "+91 98765 43210",
            "footer_email": "testpdf@example.com",
            "footer_tagline": "Test PDF Tagline",
            "show_watermark": False
        }
        
        resp = requests.put(
            f"{BASE_URL}/settings/pdf",
            headers=headers,
            json=test_data,
            timeout=10
        )
        
        if resp.status_code == 200:
            data = resp.json()
            log_pass("3b. PUT /api/settings/pdf (owner role): 200 OK")
            
            # Verify updated values
            if all(data.get(k) == v for k, v in test_data.items()):
                log_pass("3b. Updated values match")
            else:
                log_fail(f"3b. Updated values don't match: {data}")
                all_passed = False
            
            # Verify updated_at and updated_by fields
            if data.get("updated_at") and data.get("updated_by"):
                log_pass(f"3b. updated_at and updated_by fields present")
            else:
                log_fail(f"3b. Missing updated_at or updated_by fields")
                all_passed = False
        else:
            log_fail(f"3b. PUT failed: {resp.status_code}, {resp.text}")
            all_passed = False
    except Exception as e:
        log_fail(f"3b. Exception: {e}")
        all_passed = False
    
    # Test 3c: GET should reflect new values
    try:
        resp = requests.get(f"{BASE_URL}/settings/pdf", headers=headers, timeout=10)
        
        if resp.status_code == 200:
            data = resp.json()
            if data.get("footer_company_name") == "Test PDF Company" and data.get("show_watermark") is False:
                log_pass("3c. GET reflects updated values")
            else:
                log_fail(f"3c. GET doesn't reflect updates: {data}")
                all_passed = False
        else:
            log_fail(f"3c. GET failed: {resp.status_code}")
            all_passed = False
    except Exception as e:
        log_fail(f"3c. Exception: {e}")
        all_passed = False
    
    # Test 3d: Revert to original defaults
    try:
        default_data = {
            "footer_company_name": "Buildcon House",
            "footer_phone": "+91 99099 06652",
            "footer_email": "buildconhouse10@gmail.com",
            "footer_tagline": "One Destination. Infinite Possibilities.",
            "show_watermark": True
        }
        
        resp = requests.put(
            f"{BASE_URL}/settings/pdf",
            headers=headers,
            json=default_data,
            timeout=10
        )
        
        if resp.status_code == 200:
            log_pass("3d. Reverted to original defaults successfully")
        else:
            log_fail(f"3d. Failed to revert: {resp.status_code}")
            all_passed = False
    except Exception as e:
        log_fail(f"3d. Exception: {e}")
        all_passed = False
    
    return all_passed


# =============================================================================
# Test 4: GET /api/settings/catalog-backup
# =============================================================================

def test_catalog_backup():
    """Test catalog backup endpoint"""
    log_test("Test 4: GET /api/settings/catalog-backup")
    
    if not AUTH_TOKEN:
        log_fail("No auth token available")
        return False
    
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
    all_passed = True
    
    # Test 4a: Should require role >= admin (owner should succeed)
    try:
        resp = requests.get(f"{BASE_URL}/settings/catalog-backup", headers=headers, timeout=30)
        
        if resp.status_code == 200:
            log_pass("4a. GET /api/settings/catalog-backup (owner role): 200 OK")
            
            # Verify Content-Type is application/json
            content_type = resp.headers.get("Content-Type", "")
            if "application/json" in content_type:
                log_pass(f"4a. Content-Type is application/json")
            else:
                log_fail(f"4a. Content-Type is {content_type}, expected application/json")
                all_passed = False
            
            # Parse JSON and verify structure
            try:
                data = resp.json()
                
                # Check top-level keys
                required_keys = ["exported_at", "products", "brands", "categories"]
                missing_keys = [k for k in required_keys if k not in data]
                
                if not missing_keys:
                    log_pass(f"4a. All required keys present: {required_keys}")
                else:
                    log_fail(f"4a. Missing keys: {missing_keys}")
                    all_passed = False
                
                # Verify products list is non-empty
                products = data.get("products", [])
                if isinstance(products, list) and len(products) > 0:
                    log_pass(f"4a. Products list is non-empty: {len(products)} items")
                    
                    # Check if it's around 2966 items
                    if 2900 <= len(products) <= 3000:
                        log_pass(f"4a. Products count is in expected range (~2966)")
                    else:
                        log_info(f"4a. Products count {len(products)} is outside expected range 2900-3000")
                else:
                    log_fail(f"4a. Products list is empty or not a list")
                    all_passed = False
                
                # Verify each product has sku and name
                if products:
                    sample_product = products[0]
                    if "sku" in sample_product and "name" in sample_product:
                        log_pass(f"4a. Sample product has 'sku' and 'name' fields")
                    else:
                        log_fail(f"4a. Sample product missing 'sku' or 'name': {sample_product}")
                        all_passed = False
                
            except json.JSONDecodeError as e:
                log_fail(f"4a. Failed to parse JSON: {e}")
                all_passed = False
        else:
            log_fail(f"4a. GET failed: {resp.status_code}, {resp.text}")
            all_passed = False
    except Exception as e:
        log_fail(f"4a. Exception: {e}")
        all_passed = False
    
    return all_passed


# =============================================================================
# Test 5: GET /api/catalog/export.xlsx
# =============================================================================

def test_catalog_export_xlsx():
    """Test catalog Excel export endpoint"""
    log_test("Test 5: GET /api/catalog/export.xlsx")
    
    if not AUTH_TOKEN:
        log_fail("No auth token available")
        return False
    
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
    all_passed = True
    
    # Test 5a: Any authenticated staff should be able to export
    try:
        resp = requests.get(f"{BASE_URL}/catalog/export.xlsx", headers=headers, timeout=30)
        
        if resp.status_code == 200:
            log_pass("5a. GET /api/catalog/export.xlsx: 200 OK")
            
            # Verify Content-Type
            content_type = resp.headers.get("Content-Type", "")
            if "spreadsheet" in content_type or "excel" in content_type:
                log_pass(f"5a. Content-Type indicates Excel file")
            else:
                log_info(f"5a. Content-Type: {content_type}")
            
            # Verify it's a valid .xlsx file (starts with PK zip magic bytes)
            content = resp.content
            if content[:2] == b'PK':
                log_pass(f"5a. File starts with PK zip magic bytes (valid .xlsx)")
            else:
                log_fail(f"5a. File doesn't start with PK bytes, got: {content[:10]}")
                all_passed = False
            
            # Verify reasonable size (should be some KB, not empty)
            size_kb = len(content) / 1024
            if size_kb > 1:
                log_pass(f"5a. File size is reasonable: {size_kb:.2f} KB")
            else:
                log_fail(f"5a. File size is too small: {size_kb:.2f} KB")
                all_passed = False
        else:
            log_fail(f"5a. GET failed: {resp.status_code}, {resp.text}")
            all_passed = False
    except Exception as e:
        log_fail(f"5a. Exception: {e}")
        all_passed = False
    
    return all_passed


# =============================================================================
# Test 6: Team CRUD endpoints
# =============================================================================

def test_team_crud():
    """Test team management endpoints"""
    log_test("Test 6: Team CRUD (GET/POST/PATCH /api/team)")
    
    if not AUTH_TOKEN:
        log_fail("No auth token available")
        return False
    
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
    all_passed = True
    test_user_id = None
    
    # Test 6a: GET /api/team (existing, role >= manager)
    try:
        resp = requests.get(f"{BASE_URL}/team", headers=headers, timeout=10)
        
        if resp.status_code == 200:
            users = resp.json()
            log_pass(f"6a. GET /api/team: 200 OK, {len(users)} users")
        else:
            log_fail(f"6a. GET /api/team failed: {resp.status_code}")
            all_passed = False
    except Exception as e:
        log_fail(f"6a. Exception: {e}")
        all_passed = False
    
    # Test 6b: POST /api/team - create a new user (role >= admin)
    try:
        new_user_data = {
            "email": "testuser@forge.app",
            "full_name": "Test User QA",
            "role": "sales",
            "phone": "+91 98765 43210",
            "password": "TestPassword123"
        }
        
        resp = requests.post(
            f"{BASE_URL}/team",
            headers=headers,
            json=new_user_data,
            timeout=10
        )
        
        if resp.status_code == 200:
            user = resp.json()
            test_user_id = user.get("id")
            log_pass(f"6b. POST /api/team: 200 OK, created user {user.get('email')}")
            
            # Verify the new user can log in
            login_resp = requests.post(
                f"{BASE_URL}/auth/login",
                json={"email": new_user_data["email"], "password": new_user_data["password"]},
                timeout=10
            )
            
            if login_resp.status_code == 200:
                log_pass(f"6b. New user can log in successfully")
            else:
                log_fail(f"6b. New user login failed: {login_resp.status_code}")
                all_passed = False
        else:
            log_fail(f"6b. POST /api/team failed: {resp.status_code}, {resp.text}")
            all_passed = False
    except Exception as e:
        log_fail(f"6b. Exception: {e}")
        all_passed = False
    
    # Test 6c: POST /api/team - duplicate email should return 409
    try:
        resp = requests.post(
            f"{BASE_URL}/team",
            headers=headers,
            json={
                "email": "testuser@forge.app",
                "full_name": "Duplicate User",
                "role": "sales",
                "password": "TestPassword123"
            },
            timeout=10
        )
        
        if resp.status_code == 409:
            log_pass(f"6c. POST /api/team with duplicate email: 409 (correct)")
        else:
            log_fail(f"6c. Duplicate email: expected 409, got {resp.status_code}")
            all_passed = False
    except Exception as e:
        log_fail(f"6c. Exception: {e}")
        all_passed = False
    
    # Test 6d: PATCH /api/team/{user_id} - change role
    if test_user_id:
        try:
            resp = requests.patch(
                f"{BASE_URL}/team/{test_user_id}",
                headers=headers,
                json={"role": "warehouse"},
                timeout=10
            )
            
            if resp.status_code == 200:
                user = resp.json()
                if user.get("role") == "warehouse":
                    log_pass(f"6d. PATCH /api/team/{test_user_id} - role changed to warehouse")
                else:
                    log_fail(f"6d. Role not updated: {user.get('role')}")
                    all_passed = False
            else:
                log_fail(f"6d. PATCH failed: {resp.status_code}, {resp.text}")
                all_passed = False
        except Exception as e:
            log_fail(f"6d. Exception: {e}")
            all_passed = False
    
    # Test 6e: PATCH /api/team/{user_id} - deactivate user
    if test_user_id:
        try:
            resp = requests.patch(
                f"{BASE_URL}/team/{test_user_id}",
                headers=headers,
                json={"active": False},
                timeout=10
            )
            
            if resp.status_code == 200:
                user = resp.json()
                if user.get("active") is False:
                    log_pass(f"6e. PATCH /api/team/{test_user_id} - user deactivated")
                    
                    # Verify that user's login now fails with 403
                    login_resp = requests.post(
                        f"{BASE_URL}/auth/login",
                        json={"email": "testuser@forge.app", "password": "TestPassword123"},
                        timeout=10
                    )
                    
                    if login_resp.status_code == 403:
                        log_pass(f"6e. Deactivated user login: 403 (correct)")
                    else:
                        log_fail(f"6e. Deactivated user login: expected 403, got {login_resp.status_code}")
                        all_passed = False
                else:
                    log_fail(f"6e. User not deactivated: {user.get('active')}")
                    all_passed = False
            else:
                log_fail(f"6e. PATCH failed: {resp.status_code}, {resp.text}")
                all_passed = False
        except Exception as e:
            log_fail(f"6e. Exception: {e}")
            all_passed = False
    
    # Test 6f: User CANNOT deactivate their own account (400 expected)
    try:
        resp = requests.patch(
            f"{BASE_URL}/team/{OWNER_USER_ID}",
            headers=headers,
            json={"active": False},
            timeout=10
        )
        
        if resp.status_code == 400:
            log_pass(f"6f. Cannot deactivate own account: 400 (correct)")
        else:
            log_fail(f"6f. Self-deactivation: expected 400, got {resp.status_code}")
            all_passed = False
    except Exception as e:
        log_fail(f"6f. Exception: {e}")
        all_passed = False
    
    # Test 6g: User CANNOT change their own role (400 expected)
    try:
        resp = requests.patch(
            f"{BASE_URL}/team/{OWNER_USER_ID}",
            headers=headers,
            json={"role": "admin"},
            timeout=10
        )
        
        if resp.status_code == 400:
            log_pass(f"6g. Cannot change own role: 400 (correct)")
        else:
            log_fail(f"6g. Self-role-change: expected 400, got {resp.status_code}")
            all_passed = False
    except Exception as e:
        log_fail(f"6g. Exception: {e}")
        all_passed = False
    
    return all_passed


# =============================================================================
# Test 7: Regression check
# =============================================================================

def test_regression():
    """Regression check - health and PDF generation"""
    log_test("Test 7: Regression check (health + PDF generation)")
    
    if not AUTH_TOKEN:
        log_fail("No auth token available")
        return False
    
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
    all_passed = True
    
    # Test 7a: GET /api/health/system
    try:
        resp = requests.get(f"{BASE_URL}/health/system", timeout=10)
        
        if resp.status_code == 200:
            data = resp.json()
            
            if data.get("healthy") is True:
                log_pass("7a. GET /api/health/system: healthy=true")
            else:
                log_fail(f"7a. System not healthy: {data}")
                all_passed = False
            
            if data.get("version"):
                log_pass(f"7a. Version field present: {data.get('version')}")
            else:
                log_fail(f"7a. Version field missing")
                all_passed = False
            
            mongo = data.get("mongo", {})
            if mongo.get("connected") is True:
                log_pass(f"7a. Mongo connected")
            else:
                log_fail(f"7a. Mongo not connected")
                all_passed = False
            
            counts = data.get("counts", {})
            products_count = counts.get("products", 0)
            if 2900 <= products_count <= 3000:
                log_pass(f"7a. Products count in expected range: {products_count}")
            else:
                log_info(f"7a. Products count: {products_count} (expected ~2966)")
        else:
            log_fail(f"7a. GET /api/health/system failed: {resp.status_code}")
            all_passed = False
    except Exception as e:
        log_fail(f"7a. Exception: {e}")
        all_passed = False
    
    # Test 7b: GET /api/quotations/{id}/pdf - verify PDF generation still works
    try:
        # First, get a quotation ID
        resp = requests.get(f"{BASE_URL}/quotations?limit=1", headers=headers, timeout=10)
        
        if resp.status_code == 200:
            quotations = resp.json()
            if quotations and len(quotations) > 0:
                quotation_id = quotations[0].get("id")
                log_info(f"7b. Using quotation ID: {quotation_id}")
                
                # Get PDF
                pdf_resp = requests.get(
                    f"{BASE_URL}/quotations/{quotation_id}/pdf",
                    headers=headers,
                    timeout=30
                )
                
                if pdf_resp.status_code == 200:
                    content = pdf_resp.content
                    
                    # Verify it starts with %PDF
                    if content[:4] == b'%PDF':
                        log_pass(f"7b. PDF generation works (starts with %PDF)")
                    else:
                        log_fail(f"7b. PDF doesn't start with %PDF: {content[:10]}")
                        all_passed = False
                    
                    # Verify reasonable size
                    size_kb = len(content) / 1024
                    if size_kb > 1:
                        log_pass(f"7b. PDF size is reasonable: {size_kb:.2f} KB")
                    else:
                        log_fail(f"7b. PDF size too small: {size_kb:.2f} KB")
                        all_passed = False
                else:
                    log_fail(f"7b. PDF generation failed: {pdf_resp.status_code}")
                    all_passed = False
            else:
                log_info(f"7b. No quotations available to test PDF generation")
        else:
            log_fail(f"7b. Could not fetch quotations: {resp.status_code}")
            all_passed = False
    except Exception as e:
        log_fail(f"7b. Exception: {e}")
        all_passed = False
    
    return all_passed


# =============================================================================
# Main Test Runner
# =============================================================================

def main():
    print(f"\n{Colors.BLUE}{'='*80}{Colors.RESET}")
    print(f"{Colors.BLUE}Backend Settings Endpoints Testing{Colors.RESET}")
    print(f"{Colors.BLUE}Forge / BuildCon House App{Colors.RESET}")
    print(f"{Colors.BLUE}{'='*80}{Colors.RESET}")
    
    results = {}
    
    # Setup: Login
    if not test_login():
        print(f"\n{Colors.RED}{'='*80}{Colors.RESET}")
        print(f"{Colors.RED}LOGIN FAILED - Cannot proceed with tests{Colors.RESET}")
        print(f"{Colors.RED}{'='*80}{Colors.RESET}\n")
        return 1
    
    # Run all tests
    print(f"\n{Colors.YELLOW}{'='*80}{Colors.RESET}")
    print(f"{Colors.YELLOW}Running Settings Endpoint Tests{Colors.RESET}")
    print(f"{Colors.YELLOW}{'='*80}{Colors.RESET}")
    
    results["test_1_change_password"] = test_change_password()
    results["test_2_company_settings"] = test_company_settings()
    results["test_3_pdf_settings"] = test_pdf_settings()
    results["test_4_catalog_backup"] = test_catalog_backup()
    results["test_5_catalog_export_xlsx"] = test_catalog_export_xlsx()
    results["test_6_team_crud"] = test_team_crud()
    results["test_7_regression"] = test_regression()
    
    # Summary
    print(f"\n{Colors.BLUE}{'='*80}{Colors.RESET}")
    print(f"{Colors.BLUE}SUMMARY{Colors.RESET}")
    print(f"{Colors.BLUE}{'='*80}{Colors.RESET}")
    
    passed = sum(1 for v in results.values() if v)
    total = len(results)
    
    for key, result in results.items():
        status = "✓ PASS" if result else "✗ FAIL"
        color = Colors.GREEN if result else Colors.RED
        print(f"  {color}{status}{Colors.RESET} {key}")
    
    print(f"\n{Colors.BLUE}Total: {passed}/{total} tests passed{Colors.RESET}")
    
    if passed == total:
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
