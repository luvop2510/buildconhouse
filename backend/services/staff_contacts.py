"""Contact validation for team writes, separate from tolerant legacy reads."""
import re
from pydantic import EmailStr, TypeAdapter, ValidationError

_EMAIL = TypeAdapter(EmailStr)


def optional_email(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("Enter a valid email address")
    return value.strip().lower() or None


def validate_staff_phone(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("Enter a phone number as text")
    value = value.strip()
    if not value:
        return None
    if len(value) > 40 or not re.fullmatch(r"\+?[0-9 ()-]+", value):
        raise ValueError("Use digits, spaces, parentheses or hyphens, with an optional leading +")
    if not 7 <= len(re.sub(r"[^0-9]", "", value)) <= 15:
        raise ValueError("Phone numbers must contain 7 to 15 digits")
    return value


def read_staff_phone(value):
    # Old imports sometimes stored contacts as JSON numbers. An unrelated
    # contact must never prevent authenticating a valid account.
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        value = str(int(value)) if isinstance(value, float) and value.is_integer() else str(value)
    return value.strip() or None if isinstance(value, str) else None


def read_staff_email(value):
    # Malformed legacy contact data is display data, never evidence that the
    # account's password or username session is invalid.
    try:
        value = optional_email(value)
        return _EMAIL.validate_python(value) if value else None
    except (ValueError, ValidationError):
        return None
