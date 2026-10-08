#!/usr/bin/env python3
"""
Debug payment overpayment validation
"""
import os
import requests
import json

BACKEND_URL = "https://buildcon-preview.preview.emergentagent.com/api"
OWNER_EMAIL = "owner@forge.app"
OWNER_PASSWORD = os.environ["FORGE_TEST_OWNER_PASSWORD"]

# Login
login_response = requests.post(f"{BACKEND_URL}/auth/login", json={
    "email": OWNER_EMAIL,
    "password": OWNER_PASSWORD
})
token = login_response.json()["access_token"]
headers = {"Authorization": f"Bearer {token}"}

# Get the quotation FQ-2026-0061
quotation_id = "e70b3982-9e21-4841-b369-7e74255cae88"
quot_response = requests.get(f"{BACKEND_URL}/quotations/{quotation_id}", headers=headers)
quotation = quot_response.json()

print(f"Quotation: {quotation.get('number')}")
print(f"Status: {quotation.get('status')}")
print(f"Grand Total: ₹{quotation.get('grand_total')}")

# Get payments for this quotation
payments_response = requests.get(f"{BACKEND_URL}/payments", headers=headers)
payments = payments_response.json()
quotation_payments = [p for p in payments if p.get("quotation_id") == quotation_id]

print(f"\nPayments for this quotation:")
for p in quotation_payments:
    print(f"  - Amount: ₹{p['amount']}, Status: {p['status']}, ID: {p['id']}")

# Calculate already paid (only completed)
already_paid = sum(p["amount"] for p in quotation_payments if p.get("status") == "completed")
print(f"\nAlready Paid (completed only): ₹{already_paid}")
print(f"Outstanding: ₹{quotation.get('grand_total') - already_paid}")

# Try to make an overpayment
overpayment_amount = (quotation.get('grand_total') - already_paid) + 5000
print(f"\nAttempting overpayment of ₹{overpayment_amount}...")

overpayment_response = requests.post(f"{BACKEND_URL}/payments", headers=headers, json={
    "quotation_id": quotation_id,
    "amount": overpayment_amount,
    "mode": "cash",
    "note": "Test overpayment debug"
})

print(f"Response status: {overpayment_response.status_code}")
print(f"Response body: {json.dumps(overpayment_response.json(), indent=2)}")

if overpayment_response.status_code == 400:
    print("\n✅ PASS: Overpayment correctly rejected")
else:
    print("\n❌ FAIL: Overpayment was accepted (should have been rejected)")
