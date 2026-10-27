"""Indian digit grouping shared by customer amounts and document exports."""
from decimal import Decimal, InvalidOperation


def format_indian_money(value: object, decimals: int = 2) -> str:
    """Format a numeric value using Indian digit grouping, without currency."""
    try:
        amount = Decimal(str(value if value is not None else 0)).quantize(Decimal(1).scaleb(-decimals))
    except (InvalidOperation, TypeError, ValueError):
        amount = Decimal("0.00")
    if not amount.is_finite():
        amount = Decimal(0)
    sign = "-" if amount < 0 else ""
    whole, _, fraction = f"{abs(amount):.{decimals}f}".partition(".")
    if len(whole) > 3:
        tail, head = whole[-3:], whole[:-3]
        groups: list[str] = []
        while head:
            groups.append(head[-2:])
            head = head[:-2]
        whole = ",".join(reversed(groups)) + "," + tail
    return f"{sign}{whole}" + (f".{fraction}" if decimals else "")
