#!/usr/bin/env python3
"""
Clean rate limit test - wait for window to expire first
"""
import os

import requests
import time

BASE_URL = "https://buildcon-preview.preview.emergentagent.com/api"
OWNER_EMAIL = "owner@forge.app"
OWNER_PASSWORD = os.environ["FORGE_TEST_OWNER_PASSWORD"]

print("="*80)
print("CLEAN RATE LIMIT TEST")
print("="*80)

print("\nWaiting 5 seconds for any previous rate limits to settle...")
time.sleep(5)

print("\nTesting the exact scenario from review request:")
print("1. Send 3 failed attempts")
print("2. Send 1 successful login (should NOT be blocked)")
print("3. Send more failed attempts until 429")

print("\n" + "-"*80)
print("Step 1: 3 failed login attempts")
print("-"*80)
for i in range(3):
    response = requests.post(
        f"{BASE_URL}/auth/login",
        json={"email": OWNER_EMAIL, "password": "WrongPassword123"}
    )
    print(f"  Attempt {i+1}: {response.status_code}")
    time.sleep(0.5)

print("\n" + "-"*80)
print("Step 2: Successful login (should work and reset counter)")
print("-"*80)
response = requests.post(
    f"{BASE_URL}/auth/login",
    json={"email": OWNER_EMAIL, "password": OWNER_PASSWORD}
)
print(f"  Successful login: {response.status_code}")

if response.status_code == 200:
    print(f"  ✅ SUCCESS - Login worked, counter was reset")
elif response.status_code == 429:
    print(f"  ❌ BLOCKED - This is the bug! Successful login should NOT be blocked")
    print(f"  Detail: {response.json().get('detail', '')}")
    print(f"\n  This means the rate limit is checking BEFORE password verification,")
    print(f"  which blocks legitimate users who had a few typos.")
else:
    print(f"  Unexpected status: {response.status_code}")

print("\n" + "-"*80)
print("Step 3: More failed attempts (should hit 429 around 8th attempt)")
print("-"*80)

for i in range(12):
    response = requests.post(
        f"{BASE_URL}/auth/login",
        json={"email": OWNER_EMAIL, "password": "WrongPassword123"}
    )
    
    if response.status_code == 429:
        print(f"  Attempt {i+1}: {response.status_code} ✅ Rate limit triggered")
        break
    else:
        print(f"  Attempt {i+1}: {response.status_code}")
    
    time.sleep(0.3)
else:
    print(f"  ❌ Rate limit NOT triggered after 12 attempts")

print("\n" + "="*80)
print("TEST COMPLETE")
print("="*80)
