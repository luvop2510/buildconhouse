"""Shared display values for Ground Floor Tiles quotation exports."""

_STATUS_LABELS = {
    "paid": "Paid",
    "pending": "Not Paid / Pending",
    "to_be_decided": "Charges To Be Decided",
    "customer_arranged": "Customer Will Arrange Transportation",
    "custom": "Custom",
}


def transportation_details(quotation: dict) -> tuple[str | None, float | None, str]:
    arrangement = quotation.get("transportation")
    if arrangement is None:
        return None, quotation.get("transportation_fee") or None, ""
    return _STATUS_LABELS.get(arrangement.get("status")), arrangement.get("amount"), arrangement.get("note") or ""
