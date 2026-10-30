"""Human-readable Indian mobile numbers; storage and dial identities stay unchanged."""
import re


def format_phone(value):
    if not value:
        return ""
    digits = re.sub(r"\D", "", str(value))
    local = digits[2:] if len(digits) == 12 and digits.startswith("91") else digits
    if len(local) != 10 or not re.fullmatch(r"[+\d\s().-]+", str(value)):
        return value
    return f"{'+91 ' if len(digits) == 12 else ''}{local[:3]}-{local[3:6]}-{local[6:8]}-{local[8:]}"


def required_phone(value):
    if not isinstance(value, str) or not re.fullmatch(r"[+\d\s().-]+", value):
        raise ValueError("Enter a valid 10-digit phone number")
    digits = re.sub(r"\D", "", value)
    if not re.fullmatch(r"(?:91)?\d{10}", digits):
        raise ValueError("Enter a valid 10-digit phone number")
    return value.strip()
