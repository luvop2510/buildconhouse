"""Six-character policy applies to every password assignment entry point."""
import pytest
from pydantic import ValidationError

from models import (UserCreate, CustomerCreate, ChangePasswordPayload,
                    TeamCreatePayload, TeamPasswordResetPayload)
from services.password_policy import validate_new_password


ASSIGNMENTS = [
    (UserCreate, {"full_name": "Staff", "role": "sales"}, "password"),
    (CustomerCreate, {"name": "Customer"}, "password"),
    (ChangePasswordPayload, {"current_password": "existing"}, "new_password"),
    (TeamCreatePayload, {"full_name": "Staff", "role": "worker"}, "password"),
    (TeamPasswordResetPayload, {}, "new_password"),
]


@pytest.mark.parametrize("model,payload,field", ASSIGNMENTS)
@pytest.mark.parametrize("password", ["a" * 6, "a" * 11, "a" * 72, "😀" * 6])
def test_password_assignments_accept_six_or_more(model, payload, field, password):
    assert getattr(model(**payload, **{field: password}), field) == password


@pytest.mark.parametrize("model,payload,field", ASSIGNMENTS)
@pytest.mark.parametrize("password", ["", "a" * 5, "😀" * 3, "a" * 73, "😀" * 19])
def test_password_assignments_reject_short_or_oversize(model, payload, field, password):
    with pytest.raises(ValidationError):
        model(**payload, **{field: password})


def test_direct_policy_preserves_the_same_boundaries_and_optional_portal_password():
    with pytest.raises(ValueError, match="at least 6"):
        validate_new_password("12345")
    assert validate_new_password("123456") == "123456"
    assert CustomerCreate(name="Customer").password is None
