#!/usr/bin/env python3
"""
Rate limit test with session to ensure same connection/IP
"""
import os

import requests
import time

BASE_URL = "https://buildcon-preview.preview.emergentagent.com/api"
OWNER_EMAIL = "owner@forge.app"
OWNER_PASSWORD = os.environ["FORGE_TEST_OWNER_PASSWORD"]

# Use a session to maintain the same connection
session = requests.Session()

print("="*80)
print("RATE LIMIT TEST WITH SESSION (same IP)")
print("="*80)

print("\nStep 1: 3 failed attempts")
for i in range(3):
    response = session.post(
        f"{BASE_URL}/auth/login",
        json={"email": OWNER_EMAIL, "password": "WrongPassword123"}
    )
    print(f"  Attempt {i+1}: {response.status_code}")
    time.sleep(0.3)

print("\nStep 2: Successful login")
response = session.post(
    f"{BASE_URL}/auth/login",
    json={"email": OWNER_EMAIL, "password": OWNER_PASSWORD}
)
print(f"  Success: {response.status_code}")

print("\nStep 3: More failed attempts until 429")
for i in range(15):
    response = session.post(
        f"{BASE_URL}/auth/login",
        json={"email": OWNER_EMAIL, "password": "WrongPassword123"}
    )
    
    if response.status_code == 429:
        print(f"  Attempt {i+1}: {response.status_code} ✅ RATE LIMITED")
        break
    else:
        print(f"  Attempt {i+1}: {response.status_code}")
    
    time.sleep(0.3)
else:
    print(f"  ❌ No 429 after 15 attempts")

session.close()
