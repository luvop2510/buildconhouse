#!/usr/bin/env python3
"""
Focused test for rate limiting - testing the exact scenario from review request
"""
import os

import requests
import time

BASE_URL = "https://buildcon-preview.preview.emergentagent.com/api"
OWNER_EMAIL = "owner@forge.app"
OWNER_PASSWORD = os.environ["FORGE_TEST_OWNER_PASSWORD"]

print("="*80)
print("FOCUSED RATE LIMIT TEST")
print("="*80)

# Test the exact scenario from the review request:
# 1. Send 3 requests with wrong password - expect 401 each time
# 2. Send 1 request with CORRECT password - expect 200 (success should NOT be blocked)
# 3. Send 9 more requests with wrong password - expect 429 by around 8th-9th attempt

print("\nStep 1: Send 3 failed login attempts...")
for i in range(3):
    response = requests.post(
        f"{BASE_URL}/auth/login",
        json={"email": OWNER_EMAIL, "password": "WrongPassword123"}
    )
    print(f"  Attempt {i+1}: {response.status_code} - {response.json().get('detail', '')}")
    time.sleep(0.2)

print("\nStep 2: Send successful login (should clear counter and succeed)...")
response = requests.post(
    f"{BASE_URL}/auth/login",
    json={"email": OWNER_EMAIL, "password": OWNER_PASSWORD}
)
print(f"  Success attempt: {response.status_code}")
if response.status_code == 200:
    print(f"  ✅ Successful login worked (counter was cleared)")
else:
    print(f"  ❌ Successful login failed: {response.json().get('detail', '')}")

print("\nStep 3: Send 10 more failed attempts (should hit 429 around 8th-9th)...")
for i in range(10):
    response = requests.post(
        f"{BASE_URL}/auth/login",
        json={"email": OWNER_EMAIL, "password": "WrongPassword123"}
    )
    print(f"  Attempt {i+1}: {response.status_code} - {response.json().get('detail', '')[:80] if response.status_code != 200 else ''}")
    
    if response.status_code == 429:
        print(f"\n✅ Rate limit triggered at attempt {i+1}")
        break
    
    time.sleep(0.2)
else:
    print(f"\n❌ Rate limit NOT triggered after 10 attempts")

print("\n" + "="*80)
print("Testing with a different email to verify per-email scoping...")
print("="*80)

# Test that a different email is not blocked
print("\nAttempting login with a different email (should not be blocked)...")
response = requests.post(
    f"{BASE_URL}/auth/login",
    json={"email": "different@example.com", "password": "test"}
)
print(f"  Different email attempt: {response.status_code}")
if response.status_code == 401:
    print(f"  ✅ Different email gets 401 (not blocked by rate limit, just wrong credentials)")
elif response.status_code == 429:
    print(f"  ⚠️  Different email is also rate limited (may be IP-based limit)")
else:
    print(f"  Status: {response.status_code}")

print("\n" + "="*80)
print("FOCUSED TEST COMPLETE")
print("="*80)
