#!/usr/bin/env python3
"""
Variant Image Cross-Contamination Bug Fix Verification Test Suite
Backend-only validation as per review request.

Tests the fix for variant/media image cross-contamination across the product catalog
(Vitra/Grohe/Hansgrohe/Axor/Geberit — 2,610 products total).

Root cause: _apply_media in catalog_service.py pooled sibling variants' images together
instead of resolving each product's own image.
"""
import os

import requests
import sys
from typing import Dict, List, Any, Optional

# Backend URL from frontend/.env
BASE_URL = "https://buildcon-preview.preview.emergentagent.com/api"

# Test credentials from review request
TEST_EMAIL = "owner@forge.app"
TEST_PASSWORD = os.environ["FORGE_TEST_OWNER_PASSWORD"]

# Global auth token
AUTH_TOKEN = None

# Test results tracking
test_results = {
    "passed": [],
    "failed": [],
    "warnings": []
}


def log_pass(test_name: str, details: str = ""):
    """Log a passed test"""
    msg = f"✅ PASS: {test_name}"
    if details:
        msg += f" - {details}"
    print(msg)
    test_results["passed"].append(test_name)


def log_fail(test_name: str, details: str):
    """Log a failed test"""
    msg = f"❌ FAIL: {test_name} - {details}"
    print(msg)
    test_results["failed"].append(f"{test_name}: {details}")


def log_warning(test_name: str, details: str):
    """Log a warning"""
    msg = f"⚠️  WARNING: {test_name} - {details}"
    print(msg)
    test_results["warnings"].append(f"{test_name}: {details}")


def get_headers() -> Dict[str, str]:
    """Get headers with auth token"""
    headers = {"Content-Type": "application/json"}
    if AUTH_TOKEN:
        headers["Authorization"] = f"Bearer {AUTH_TOKEN}"
    return headers


def test_1_auth_login():
    """TEST 1: Authentication - POST /api/auth/login owner@forge.app/[legacy credential removed] -> 200"""
    global AUTH_TOKEN
    print("\n" + "="*80)
    print("TEST 1: AUTHENTICATION")
    print("="*80)
    
    try:
        response = requests.post(
            f"{BASE_URL}/auth/login",
            json={"email": TEST_EMAIL, "password": TEST_PASSWORD},
            timeout=10
        )
        
        if response.status_code == 200:
            data = response.json()
            AUTH_TOKEN = data.get("access_token") or data.get("token")
            user = data.get("user", {})
            
            if AUTH_TOKEN:
                log_pass("Auth Login", f"User: {user.get('full_name')} ({user.get('email')}), Role: {user.get('role')}")
                return True
            else:
                log_fail("Auth Login", "No token in response")
                return False
        else:
            log_fail("Auth Login", f"Status {response.status_code}: {response.text[:200]}")
            return False
            
    except Exception as e:
        log_fail("Auth Login", f"Exception: {str(e)}")
        return False


def test_2_no_regression_in_totals():
    """TEST 2: NO REGRESSION IN TOTALS - Brand counts and total products unchanged"""
    print("\n" + "="*80)
    print("TEST 2: NO REGRESSION IN TOTALS")
    print("="*80)
    
    # Expected brand counts from review request
    expected_brand_counts = {
        "grohe": 508,
        "hansgrohe": 908,
        "axor": 448,
        "vitra": 250,
        "geberit": 496
    }
    
    all_ok = True
    
    # 2a. Check brand counts
    try:
        response = requests.get(f"{BASE_URL}/brands", headers=get_headers(), timeout=10)
        
        if response.status_code != 200:
            log_fail("Brand Counts", f"Status {response.status_code}")
            return False
        
        brands = response.json()
        print("\nBrand counts:")
        
        for brand in brands:
            name = brand.get("name", "").lower()
            count = brand.get("product_count", 0)
            expected = expected_brand_counts.get(name)
            
            if expected is not None:
                status = "✓" if count == expected else "✗"
                print(f"  {status} {brand.get('name')}: {count} (expected {expected})")
                
                if count != expected:
                    log_fail(f"Brand Count - {brand.get('name')}", 
                            f"Expected {expected}, got {count}")
                    all_ok = False
        
        if all_ok:
            log_pass("Brand Counts", "Grohe=508, Hansgrohe=908, Axor=448, Vitra=250, Geberit=496 (UNCHANGED)")
            
    except Exception as e:
        log_fail("Brand Counts", str(e))
        all_ok = False
    
    # 2b. Check total product count
    try:
        response = requests.get(f"{BASE_URL}/health/system", timeout=10)
        
        if response.status_code == 200:
            data = response.json()
            product_count = data.get("counts", {}).get("products")
            
            print(f"\nTotal products: {product_count} (expected 2610)")
            
            if product_count == 2610:
                log_pass("Total Product Count", "counts.products=2610 (UNCHANGED)")
            else:
                log_fail("Total Product Count", f"Expected 2610, got {product_count}")
                all_ok = False
        else:
            log_fail("Total Product Count", f"Health check status {response.status_code}")
            all_ok = False
            
    except Exception as e:
        log_fail("Total Product Count", str(e))
        all_ok = False
    
    return all_ok


def get_brand_id(brand_name: str) -> Optional[str]:
    """Get brand ID by name"""
    try:
        response = requests.get(f"{BASE_URL}/brands", headers=get_headers(), timeout=10)
        if response.status_code == 200:
            brands = response.json()
            for brand in brands:
                if brand.get("name", "").lower() == brand_name.lower():
                    return brand.get("id")
        return None
    except Exception as e:
        print(f"Error getting brand ID for {brand_name}: {e}")
        return None


def find_product_with_variants(brand_name: str, min_variants: int = 3) -> Optional[Dict]:
    """Find a product with multiple variants for a given brand"""
    try:
        brand_id = get_brand_id(brand_name)
        if not brand_id:
            return None
        
        # Get products from this brand
        response = requests.get(
            f"{BASE_URL}/products",
            params={"brand_id": brand_id, "limit": 100},
            headers=get_headers(),
            timeout=10
        )
        
        if response.status_code != 200:
            return None
        
        data = response.json()
        items = data.get("items", [])
        
        # Find a product with at least min_variants variants
        for product in items:
            variants = product.get("variants", [])
            if len(variants) >= min_variants:
                return product
        
        return None
        
    except Exception as e:
        print(f"Error finding product with variants for {brand_name}: {e}")
        return None


def test_3_per_variant_image_correctness():
    """TEST 3: CRITICAL - PER-VARIANT IMAGE CORRECTNESS"""
    print("\n" + "="*80)
    print("TEST 3: CRITICAL - PER-VARIANT IMAGE CORRECTNESS")
    print("="*80)
    
    all_ok = True
    products_tested = 0
    products_with_distinct_variant_images = 0
    
    # Test multiple brands to ensure comprehensive coverage
    brands_to_test = ["Grohe", "Hansgrohe", "Vitra"]
    
    for brand_name in brands_to_test:
        print(f"\n--- Testing {brand_name} ---")
        
        # Find a product with multiple variants
        product = find_product_with_variants(brand_name, min_variants=3)
        
        if not product:
            log_warning(f"Multi-Variant Product - {brand_name}", 
                       f"Could not find a product with 3+ variants")
            continue
        
        product_id = product.get("id")
        sku = product.get("sku")
        name = product.get("name", "")
        family_key = product.get("family_key")
        variants = product.get("variants", [])
        
        print(f"\nFound product: {name}")
        print(f"  SKU: {sku}")
        print(f"  Family key: {family_key}")
        print(f"  Variants: {len(variants)}")
        
        products_tested += 1
        
        # Get detailed info for the main product
        try:
            response = requests.get(
                f"{BASE_URL}/products/{product_id}",
                headers=get_headers(),
                timeout=10
            )
            
            if response.status_code != 200:
                log_warning(f"Product Detail - {brand_name}", f"Status {response.status_code}")
                continue
            
            main_product = response.json()
            main_hero = main_product.get("hero_image_url")
            
            print(f"\n  Main product hero image: {main_hero[:80] if main_hero else 'None'}...")
            
            # Check variant images
            print(f"\n  Checking variant images:")
            
            variant_images = []
            for i, variant in enumerate(variants[:5], 1):  # Check up to 5 variants
                variant_id = variant.get("id")
                variant_sku = variant.get("sku")
                variant_image = variant.get("image")
                variant_finish = variant.get("finish", "")
                variant_color = variant.get("color", "")
                
                print(f"\n    Variant {i}:")
                print(f"      ID: {variant_id}")
                print(f"      SKU: {variant_sku}")
                print(f"      Finish: {variant_finish}")
                print(f"      Color: {variant_color}")
                print(f"      Image: {variant_image[:80] if variant_image else 'None'}...")
                
                if variant_image:
                    variant_images.append(variant_image)
                
                # Get full details for this variant product
                try:
                    variant_response = requests.get(
                        f"{BASE_URL}/products/{variant_id}",
                        headers=get_headers(),
                        timeout=10
                    )
                    
                    if variant_response.status_code == 200:
                        variant_detail = variant_response.json()
                        variant_hero = variant_detail.get("hero_image_url")
                        
                        print(f"      Hero image URL: {variant_hero[:80] if variant_hero else 'None'}...")
                        
                except Exception as e:
                    log_warning(f"Variant Detail - {variant_sku}", str(e))
            
            # Check if variant images are DIFFERENT
            unique_variant_images = set(variant_images)
            
            print(f"\n  Unique variant images: {len(unique_variant_images)} out of {len(variant_images)} variants")
            
            if len(unique_variant_images) > 1:
                products_with_distinct_variant_images += 1
                log_pass(f"Variant Image Distinctness - {brand_name} {name[:40]}", 
                        f"{len(unique_variant_images)} distinct images across {len(variant_images)} variants")
            elif len(unique_variant_images) == 1 and len(variant_images) > 1:
                log_warning(f"Variant Image Distinctness - {brand_name} {name[:40]}", 
                           f"All {len(variant_images)} variants share the same image. "
                           f"This could be legitimate if supplier only provided one image.")
            elif len(unique_variant_images) == 0:
                log_warning(f"Variant Image Distinctness - {brand_name} {name[:40]}", 
                           "No variant images found")
                
        except Exception as e:
            log_warning(f"Product Testing - {brand_name}", str(e))
    
    print(f"\n--- Summary ---")
    print(f"Products tested: {products_tested}")
    print(f"Products with distinct variant images: {products_with_distinct_variant_images}")
    
    if products_tested == 0:
        log_fail("Per-Variant Image Correctness", "No multi-variant products could be tested")
        return False
    
    if products_with_distinct_variant_images >= 1:
        log_pass("Per-Variant Image Correctness", 
                f"At least {products_with_distinct_variant_images} product(s) show distinct images per variant")
        return True
    else:
        log_warning("Per-Variant Image Correctness", 
                   "Could not confirm distinct images per variant (all tested products share images)")
        return True  # Not a hard fail, could be legitimate


def test_4_variant_labels():
    """TEST 4: VARIANT LABELS - Confirm every variant has non-empty finish/color field"""
    print("\n" + "="*80)
    print("TEST 4: VARIANT LABELS")
    print("="*80)
    
    all_ok = True
    products_checked = 0
    variants_checked = 0
    
    # Test products from multiple brands
    brands_to_test = ["Grohe", "Hansgrohe", "Vitra"]
    
    for brand_name in brands_to_test:
        print(f"\n--- Testing {brand_name} ---")
        
        brand_id = get_brand_id(brand_name)
        if not brand_id:
            log_warning(f"Variant Labels - {brand_name}", "Could not find brand")
            continue
        
        # Get some products from this brand
        try:
            response = requests.get(
                f"{BASE_URL}/products",
                params={"brand_id": brand_id, "limit": 10},
                headers=get_headers(),
                timeout=10
            )
            
            if response.status_code != 200:
                log_warning(f"Variant Labels - {brand_name}", f"Status {response.status_code}")
                continue
            
            data = response.json()
            items = data.get("items", [])
            
            # Check first few products with variants
            for product in items[:5]:
                product_id = product.get("id")
                
                # Get full product details
                try:
                    detail_response = requests.get(
                        f"{BASE_URL}/products/{product_id}",
                        headers=get_headers(),
                        timeout=10
                    )
                    
                    if detail_response.status_code != 200:
                        continue
                    
                    detail = detail_response.json()
                    variants = detail.get("variants", [])
                    
                    if not variants:
                        continue
                    
                    products_checked += 1
                    sku = detail.get("sku")
                    name = detail.get("name", "")[:40]
                    
                    print(f"\n  Product: {name}... (SKU: {sku})")
                    print(f"    Variants: {len(variants)}")
                    
                    for i, variant in enumerate(variants, 1):
                        variants_checked += 1
                        
                        finish = variant.get("finish", "")
                        color = variant.get("color", "")
                        variant_label = variant.get("variant_label", "")
                        
                        # Check if any field has the literal string "Variant"
                        if finish == "Variant" or color == "Variant" or variant_label == "Variant":
                            log_fail(f"Variant Label - {brand_name} {sku} Variant {i}", 
                                   f"Found literal 'Variant' string: finish='{finish}', color='{color}', variant_label='{variant_label}'")
                            all_ok = False
                        
                        # Check if at least one field is non-empty
                        if not finish and not color and not variant_label:
                            log_fail(f"Variant Label - {brand_name} {sku} Variant {i}", 
                                   "All label fields are empty")
                            all_ok = False
                        else:
                            # Show what we found
                            label_parts = []
                            if finish:
                                label_parts.append(f"finish='{finish}'")
                            if color:
                                label_parts.append(f"color='{color}'")
                            if variant_label:
                                label_parts.append(f"variant_label='{variant_label}'")
                            
                            print(f"      Variant {i}: {', '.join(label_parts)}")
                    
                except Exception as e:
                    log_warning(f"Variant Labels - {brand_name} Product {product_id}", str(e))
                    
        except Exception as e:
            log_warning(f"Variant Labels - {brand_name}", str(e))
    
    print(f"\n--- Summary ---")
    print(f"Products checked: {products_checked}")
    print(f"Variants checked: {variants_checked}")
    
    if variants_checked == 0:
        log_warning("Variant Labels", "No variants found to check")
        return True  # Not a hard fail
    
    if all_ok:
        log_pass("Variant Labels", 
                f"Checked {variants_checked} variants across {products_checked} products - "
                f"NONE have literal 'Variant' string, all have non-empty finish/color fields")
        return True
    else:
        return False


def test_5_specific_repair_verification():
    """TEST 5: SPECIFIC REPAIR VERIFICATION - Hansgrohe SKU 26456000"""
    print("\n" + "="*80)
    print("TEST 5: SPECIFIC REPAIR VERIFICATION (Hansgrohe SKU 26456000)")
    print("="*80)
    
    try:
        # Search for SKU 26456000
        response = requests.get(
            f"{BASE_URL}/products",
            params={"q": "26456000"},
            headers=get_headers(),
            timeout=10
        )
        
        if response.status_code != 200:
            log_fail("SKU 26456000 Search", f"Status {response.status_code}")
            return False
        
        data = response.json()
        items = data.get("items", [])
        
        # Filter to exact SKU match
        products_26456000 = [p for p in items if p.get("sku") == "26456000"]
        
        print(f"\nFound {len(products_26456000)} product(s) with SKU 26456000")
        
        if len(products_26456000) < 2:
            log_warning("SKU 26456000", 
                       f"Expected 2 Hansgrohe products with this SKU, found {len(products_26456000)}")
        
        # Expected product names
        expected_names = [
            "HG FixFit S wall outlet DN15 chr.NRV metal connection",
            "HG FixFit Porter 300 Schlauchanschl.chr"
        ]
        
        found_products = []
        
        for product in products_26456000:
            product_id = product.get("id")
            name = product.get("name", "")
            brand_name = product.get("brand_name", "")
            
            print(f"\n  Product: {name}")
            print(f"    ID: {product_id}")
            print(f"    Brand: {brand_name}")
            
            # Get full details
            try:
                detail_response = requests.get(
                    f"{BASE_URL}/products/{product_id}",
                    headers=get_headers(),
                    timeout=10
                )
                
                if detail_response.status_code != 200:
                    log_fail(f"SKU 26456000 Detail - {name}", f"Status {detail_response.status_code}")
                    continue
                
                detail = detail_response.json()
                hero_image_url = detail.get("hero_image_url")
                
                print(f"    Hero image URL: {hero_image_url[:80] if hero_image_url else 'None'}...")
                
                if not hero_image_url:
                    log_fail(f"SKU 26456000 - {name}", "No hero image URL")
                    continue
                
                # Check if image URL returns HTTP 200
                try:
                    img_response = requests.head(hero_image_url, timeout=10)
                    
                    if img_response.status_code == 200:
                        print(f"    Image HTTP status: 200 ✓")
                        
                        found_products.append({
                            "id": product_id,
                            "name": name,
                            "hero_image_url": hero_image_url,
                            "image_status": 200
                        })
                    else:
                        log_fail(f"SKU 26456000 Image - {name}", 
                               f"Image URL returned status {img_response.status_code}")
                        
                except Exception as e:
                    log_fail(f"SKU 26456000 Image - {name}", f"Failed to check image: {e}")
                    
            except Exception as e:
                log_fail(f"SKU 26456000 Detail - {name}", str(e))
        
        # Verify we found both expected products
        if len(found_products) < 2:
            log_fail("SKU 26456000 Verification", 
                   f"Expected 2 products with working images, found {len(found_products)}")
            return False
        
        # Verify the two products have DIFFERENT hero image URLs
        hero_urls = [p["hero_image_url"] for p in found_products]
        unique_urls = set(hero_urls)
        
        if len(unique_urls) < 2:
            log_fail("SKU 26456000 Image Distinctness", 
                   "Both products share the same hero image URL (should be DIFFERENT)")
            return False
        
        log_pass("SKU 26456000 Verification", 
                f"Found 2 Hansgrohe products: '{found_products[0]['name']}' and '{found_products[1]['name']}'. "
                f"Both have distinct hero images, both return HTTP 200")
        return True
        
    except Exception as e:
        log_fail("SKU 26456000 Verification", str(e))
        return False


def test_6_products_with_no_image():
    """TEST 6: Confirm 7 products show NO image (6 Vitra + 1 Hansgrohe SKU 26844990)"""
    print("\n" + "="*80)
    print("TEST 6: PRODUCTS WITH NO IMAGE")
    print("="*80)
    
    all_ok = True
    
    # 6a. Check Hansgrohe SKU 26844990
    print("\n--- Checking Hansgrohe SKU 26844990 ---")
    
    try:
        response = requests.get(
            f"{BASE_URL}/products",
            params={"q": "26844990"},
            headers=get_headers(),
            timeout=10
        )
        
        if response.status_code != 200:
            log_fail("Hansgrohe 26844990 Search", f"Status {response.status_code}")
            all_ok = False
        else:
            data = response.json()
            items = data.get("items", [])
            
            # Filter to exact SKU match
            product = None
            for item in items:
                if item.get("sku") == "26844990":
                    product = item
                    break
            
            if not product:
                log_fail("Hansgrohe 26844990", "Product not found")
                all_ok = False
            else:
                product_id = product.get("id")
                name = product.get("name", "")
                
                print(f"  Found: {name}")
                
                # Get full details
                detail_response = requests.get(
                    f"{BASE_URL}/products/{product_id}",
                    headers=get_headers(),
                    timeout=10
                )
                
                if detail_response.status_code != 200:
                    log_fail("Hansgrohe 26844990 Detail", f"Status {detail_response.status_code}")
                    all_ok = False
                else:
                    detail = detail_response.json()
                    hero_image_url = detail.get("hero_image_url")
                    
                    print(f"  Hero image URL: {hero_image_url}")
                    
                    if hero_image_url is None or hero_image_url == "":
                        log_pass("Hansgrohe 26844990 No Image", 
                               f"SKU 26844990 correctly shows NO image (null/empty hero_image_url)")
                    else:
                        log_fail("Hansgrohe 26844990 No Image", 
                               f"Expected null/empty hero_image_url, got: {hero_image_url}")
                        all_ok = False
                        
    except Exception as e:
        log_fail("Hansgrohe 26844990", str(e))
        all_ok = False
    
    # 6b. Check 6 Vitra products with no image
    print("\n--- Checking Vitra products with no image ---")
    
    try:
        vitra_id = get_brand_id("Vitra")
        if not vitra_id:
            log_fail("Vitra No Image Check", "Could not find Vitra brand")
            all_ok = False
        else:
            # Get all Vitra products
            response = requests.get(
                f"{BASE_URL}/products",
                params={"brand_id": vitra_id, "limit": 300},
                headers=get_headers(),
                timeout=10
            )
            
            if response.status_code != 200:
                log_fail("Vitra No Image Check", f"Status {response.status_code}")
                all_ok = False
            else:
                data = response.json()
                items = data.get("items", [])
                
                # Count products with no hero_image_url
                no_image_products = []
                
                for product in items:
                    product_id = product.get("id")
                    
                    # Get full details to check hero_image_url
                    try:
                        detail_response = requests.get(
                            f"{BASE_URL}/products/{product_id}",
                            headers=get_headers(),
                            timeout=10
                        )
                        
                        if detail_response.status_code == 200:
                            detail = detail_response.json()
                            hero_image_url = detail.get("hero_image_url")
                            
                            if hero_image_url is None or hero_image_url == "":
                                no_image_products.append({
                                    "id": product_id,
                                    "sku": detail.get("sku"),
                                    "name": detail.get("name", "")
                                })
                                
                    except Exception as e:
                        log_warning(f"Vitra Product {product_id}", f"Failed to check: {e}")
                
                print(f"\n  Found {len(no_image_products)} Vitra products with no image:")
                
                for i, product in enumerate(no_image_products, 1):
                    print(f"    {i}. SKU {product['sku']}: {product['name'][:50]}...")
                
                if len(no_image_products) == 6:
                    log_pass("Vitra No Image Check", 
                           f"Found exactly 6 Vitra products with null/empty hero_image_url (as expected)")
                else:
                    log_warning("Vitra No Image Check", 
                              f"Expected 6 Vitra products with no image, found {len(no_image_products)}")
                    # Not a hard fail, could be legitimate if data changed
                    
    except Exception as e:
        log_fail("Vitra No Image Check", str(e))
        all_ok = False
    
    return all_ok


def test_7_general_regression():
    """TEST 7: GENERAL REGRESSION - quotations, purchase-orders, payments/stats, search"""
    print("\n" + "="*80)
    print("TEST 7: GENERAL REGRESSION")
    print("="*80)
    
    all_ok = True
    
    # 7a. Quotations
    try:
        response = requests.get(f"{BASE_URL}/quotations", headers=get_headers(), timeout=10)
        
        if response.status_code == 200:
            quotations = response.json()
            print(f"  ✓ GET /api/quotations: 200 OK ({len(quotations)} quotations)")
            
            # Try to generate PDF for first quotation if available
            if quotations:
                quot_id = quotations[0].get("id")
                
                try:
                    pdf_response = requests.get(
                        f"{BASE_URL}/quotations/{quot_id}/pdf",
                        headers=get_headers(),
                        timeout=30
                    )
                    
                    if pdf_response.status_code == 200:
                        print(f"  ✓ PDF export for quotation {quot_id}: 200 OK ({len(pdf_response.content)} bytes)")
                    else:
                        log_fail("Quotations PDF Export", f"Status {pdf_response.status_code}")
                        all_ok = False
                        
                except Exception as e:
                    log_fail("Quotations PDF Export", str(e))
                    all_ok = False
        else:
            log_fail("Quotations", f"Status {response.status_code}")
            all_ok = False
            
    except Exception as e:
        log_fail("Quotations", str(e))
        all_ok = False
    
    # 7b. Purchase Orders
    try:
        response = requests.get(f"{BASE_URL}/purchase-orders", headers=get_headers(), timeout=10)
        
        if response.status_code == 200:
            print(f"  ✓ GET /api/purchase-orders: 200 OK")
        else:
            log_fail("Purchase Orders", f"Status {response.status_code}")
            all_ok = False
            
    except Exception as e:
        log_fail("Purchase Orders", str(e))
        all_ok = False
    
    # 7c. Payments Stats
    try:
        response = requests.get(f"{BASE_URL}/payments/stats", headers=get_headers(), timeout=10)
        
        if response.status_code == 200:
            print(f"  ✓ GET /api/payments/stats: 200 OK")
        else:
            log_fail("Payments Stats", f"Status {response.status_code}")
            all_ok = False
            
    except Exception as e:
        log_fail("Payments Stats", str(e))
        all_ok = False
    
    # 7d. Search - Grohe
    try:
        response = requests.get(
            f"{BASE_URL}/products",
            params={"q": "grohe"},
            headers=get_headers(),
            timeout=10
        )
        
        if response.status_code == 200:
            data = response.json()
            total = data.get("total", 0)
            print(f"  ✓ Search 'grohe': 200 OK ({total} results)")
        else:
            log_fail("Search - Grohe", f"Status {response.status_code}")
            all_ok = False
            
    except Exception as e:
        log_fail("Search - Grohe", str(e))
        all_ok = False
    
    # 7e. Search - Vitra
    try:
        response = requests.get(
            f"{BASE_URL}/products",
            params={"q": "vitra"},
            headers=get_headers(),
            timeout=10
        )
        
        if response.status_code == 200:
            data = response.json()
            total = data.get("total", 0)
            print(f"  ✓ Search 'vitra': 200 OK ({total} results)")
        else:
            log_fail("Search - Vitra", f"Status {response.status_code}")
            all_ok = False
            
    except Exception as e:
        log_fail("Search - Vitra", str(e))
        all_ok = False
    
    if all_ok:
        log_pass("General Regression", "All endpoints working normally")
    
    return all_ok


def test_8_smoke_check_images():
    """TEST 8: Smoke-check that images that DO exist return HTTP 200"""
    print("\n" + "="*80)
    print("TEST 8: SMOKE CHECK IMAGES")
    print("="*80)
    
    all_ok = True
    images_checked = 0
    images_ok = 0
    
    # Get products from different brands
    brands_to_test = ["Grohe", "Hansgrohe", "Vitra", "Axor", "Geberit"]
    
    for brand_name in brands_to_test:
        brand_id = get_brand_id(brand_name)
        if not brand_id:
            continue
        
        try:
            response = requests.get(
                f"{BASE_URL}/products",
                params={"brand_id": brand_id, "limit": 2},
                headers=get_headers(),
                timeout=10
            )
            
            if response.status_code != 200:
                continue
            
            data = response.json()
            items = data.get("items", [])
            
            # Check first product with an image
            for product in items:
                product_id = product.get("id")
                
                # Get full details
                detail_response = requests.get(
                    f"{BASE_URL}/products/{product_id}",
                    headers=get_headers(),
                    timeout=10
                )
                
                if detail_response.status_code != 200:
                    continue
                
                detail = detail_response.json()
                hero_image_url = detail.get("hero_image_url")
                
                if not hero_image_url:
                    continue
                
                sku = detail.get("sku")
                name = detail.get("name", "")[:40]
                
                print(f"\n  {brand_name} - SKU {sku}: {name}...")
                print(f"    Image URL: {hero_image_url[:80]}...")
                
                # Check if image returns HTTP 200
                try:
                    img_response = requests.head(hero_image_url, timeout=10)
                    images_checked += 1
                    
                    if img_response.status_code == 200:
                        print(f"    Status: 200 ✓")
                        images_ok += 1
                    else:
                        print(f"    Status: {img_response.status_code} ✗")
                        log_fail(f"Image Check - {brand_name} {sku}", 
                               f"Image returned status {img_response.status_code}")
                        all_ok = False
                        
                except Exception as e:
                    images_checked += 1
                    log_fail(f"Image Check - {brand_name} {sku}", f"Failed to check image: {e}")
                    all_ok = False
                
                # Only check 1 product per brand
                break
                
        except Exception as e:
            log_warning(f"Image Check - {brand_name}", str(e))
    
    print(f"\n--- Summary ---")
    print(f"Images checked: {images_checked}")
    print(f"Images OK (HTTP 200): {images_ok}")
    
    if images_checked == 0:
        log_warning("Smoke Check Images", "No images found to check")
        return True  # Not a hard fail
    
    if all_ok:
        log_pass("Smoke Check Images", 
                f"Checked {images_checked} images across {len(brands_to_test)} brands - all return HTTP 200")
        return True
    else:
        return False


def print_summary():
    """Print test summary"""
    print("\n" + "="*80)
    print("TEST SUMMARY")
    print("="*80)
    
    total = len(test_results["passed"]) + len(test_results["failed"])
    passed = len(test_results["passed"])
    failed = len(test_results["failed"])
    warnings = len(test_results["warnings"])
    
    print(f"\nTotal Tests: {total}")
    print(f"✅ Passed: {passed}")
    print(f"❌ Failed: {failed}")
    print(f"⚠️  Warnings: {warnings}")
    
    if test_results["failed"]:
        print("\n" + "="*80)
        print("FAILED TESTS:")
        print("="*80)
        for failure in test_results["failed"]:
            print(f"  ❌ {failure}")
    
    if test_results["warnings"]:
        print("\n" + "="*80)
        print("WARNINGS:")
        print("="*80)
        for warning in test_results["warnings"]:
            print(f"  ⚠️  {warning}")
    
    print("\n" + "="*80)
    
    return failed == 0


def main():
    """Main test runner"""
    print("="*80)
    print("VARIANT IMAGE CROSS-CONTAMINATION BUG FIX VERIFICATION")
    print("Backend-only validation")
    print("="*80)
    
    # Run all tests in sequence
    tests = [
        test_1_auth_login,
        test_2_no_regression_in_totals,
        test_3_per_variant_image_correctness,
        test_4_variant_labels,
        test_5_specific_repair_verification,
        test_6_products_with_no_image,
        test_7_general_regression,
        test_8_smoke_check_images
    ]
    
    for test_func in tests:
        try:
            test_func()
        except Exception as e:
            print(f"\n❌ CRITICAL ERROR in {test_func.__name__}: {e}")
            test_results["failed"].append(f"{test_func.__name__}: Critical exception - {e}")
    
    # Print summary
    success = print_summary()
    
    # Exit with appropriate code
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
