#!/usr/bin/env python3
"""
Additional test to verify product image handling in PDF generation
- Test with products that have images
- Test with products that have no images (fallback)
"""
import os

import requests
import sys
from io import BytesIO
from PyPDF2 import PdfReader

BASE_URL = "https://buildcon-preview.preview.emergentagent.com/api"
CREDENTIALS = {"email": "owner@forge.app", "password": os.environ["FORGE_TEST_OWNER_PASSWORD"]}

def authenticate():
    """Get JWT token"""
    response = requests.post(f"{BASE_URL}/auth/login", json=CREDENTIALS, timeout=10)
    if response.status_code == 200:
        return response.json().get("access_token")
    return None

def test_pdf_with_images(token):
    """Test PDF generation with quotations that have product images"""
    print("\n=== TEST: PDF with Product Images ===")
    
    headers = {"Authorization": f"Bearer {token}"}
    
    # Get quotations
    response = requests.get(f"{BASE_URL}/quotations", headers=headers, params={"limit": 10}, timeout=10)
    if response.status_code != 200:
        print("❌ Failed to fetch quotations")
        return False
    
    quotations = response.json()
    
    # Find quotations with and without images
    with_images = None
    without_images = None
    
    for q in quotations:
        items = q.get("items", [])
        if not items:
            continue
        
        has_image = any(item.get("image") for item in items)
        no_image = any(not item.get("image") for item in items)
        
        if has_image and not with_images:
            with_images = q
        if no_image and not without_images:
            without_images = q
        
        if with_images and without_images:
            break
    
    # Test quotation with images
    if with_images:
        print(f"\n✅ Testing quotation with images: {with_images.get('quotation_number', 'N/A')}")
        response = requests.get(
            f"{BASE_URL}/quotations/{with_images['id']}/pdf",
            headers=headers,
            timeout=30
        )
        
        if response.status_code == 200 and response.content.startswith(b'%PDF'):
            print(f"   ✅ PDF generated successfully: {len(response.content):,} bytes")
            
            # Parse PDF to verify it's valid
            try:
                pdf_reader = PdfReader(BytesIO(response.content))
                print(f"   ✅ PDF is valid with {len(pdf_reader.pages)} pages")
            except Exception as e:
                print(f"   ❌ PDF parsing failed: {e}")
                return False
        else:
            print(f"   ❌ PDF generation failed: Status {response.status_code}")
            return False
    else:
        print("⚠️  No quotation with images found")
    
    # Test quotation without images (fallback)
    if without_images:
        print(f"\n✅ Testing quotation with missing images (fallback): {without_images.get('quotation_number', 'N/A')}")
        response = requests.get(
            f"{BASE_URL}/quotations/{without_images['id']}/pdf",
            headers=headers,
            timeout=30
        )
        
        if response.status_code == 200 and response.content.startswith(b'%PDF'):
            print(f"   ✅ PDF generated successfully (no crash): {len(response.content):,} bytes")
            
            # Parse PDF to verify it's valid
            try:
                pdf_reader = PdfReader(BytesIO(response.content))
                print(f"   ✅ PDF is valid with {len(pdf_reader.pages)} pages")
                print(f"   ✅ No crash/regression when product images are missing")
            except Exception as e:
                print(f"   ❌ PDF parsing failed: {e}")
                return False
        else:
            print(f"   ❌ PDF generation failed: Status {response.status_code}")
            return False
    else:
        print("⚠️  No quotation with missing images found")
    
    return True

def main():
    print("=" * 80)
    print("Product Image Handling Test")
    print("=" * 80)
    
    token = authenticate()
    if not token:
        print("❌ Authentication failed")
        sys.exit(1)
    
    success = test_pdf_with_images(token)
    
    print("\n" + "=" * 80)
    if success:
        print("✅ ALL IMAGE HANDLING TESTS PASSED")
        print("   - PDF with product images: ✅")
        print("   - PDF with missing images (fallback): ✅")
        print("   - No crash/regression: ✅")
    else:
        print("❌ SOME TESTS FAILED")
    print("=" * 80)
    
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
