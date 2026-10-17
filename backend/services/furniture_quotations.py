"""Furniture RNB ledger: exact decimal snapshots and the supplied seven-column PDF."""
from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import re
from io import BytesIO
from typing import Literal
from uuid import uuid4
from xml.sax.saxutils import escape
from zoneinfo import ZoneInfo
from datetime import datetime

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

FURNITURE_FLOOR_ID = "third-floor"
CENT = Decimal("0.01")


def furniture_currency_label(currency: str) -> str:
    """Display the requested label without changing saved receipt currency codes."""
    return "RNB" if currency == "RMB" else currency


def money(value: str) -> Decimal:
    try:
        if not re.fullmatch(r"\d+(?:\.\d{1,6})?", str(value).strip()):
            raise ValueError()
        number = Decimal(str(value))
        if not number.is_finite() or number <= 0 or number > Decimal("1000000000000"):
            raise ValueError()
        if number.as_tuple().exponent < -6:
            raise ValueError()
        return number
    except (InvalidOperation, ValueError):
        raise ValueError("Enter a positive finite amount or rate with at most six decimal places")


def decimal_text(value: Decimal) -> str:
    return format(value.quantize(CENT, rounding=ROUND_HALF_UP), ".2f")


class ChargeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str | None = Field(None, max_length=64)
    description: str = Field(min_length=1, max_length=200)
    amount_rmb: str = Field(min_length=1, max_length=24)

    @field_validator("description")
    @classmethod
    def nonblank_description(cls, value):
        if not value.strip():
            raise ValueError("Enter a charge description")
        return value.strip()

    @field_validator("amount_rmb")
    @classmethod
    def valid_amount(cls, value):
        money(value)
        return value


class DepositInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str | None = Field(None, max_length=64)
    description: str = Field("Deposit by customer", min_length=1, max_length=200)
    currency: Literal["INR", "USD", "RMB"] = "INR"
    amount: str = Field(min_length=1, max_length=24)
    rate: str = Field(min_length=1, max_length=24)

    @field_validator("description")
    @classmethod
    def nonblank_description(cls, value):
        if not value.strip():
            raise ValueError("Enter a deposit description")
        return value.strip()

    @field_validator("amount", "rate")
    @classmethod
    def valid_amount(cls, value):
        money(value)
        return value


class FurnitureQuotationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    customer_name: str = Field(min_length=1, max_length=200)
    customer_phone: str = Field(min_length=8, max_length=30)
    referrer_id: str | None = Field(None, max_length=128)
    charges: list[ChargeInput] = Field(min_length=1, max_length=200)
    deposits: list[DepositInput] = Field(default_factory=list, max_length=200)
    status: Literal["draft", "final"] = "draft"
    expected_updated_at: str | None = Field(None, max_length=64)

    @field_validator("customer_name", "customer_phone")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("This field cannot be blank")
        return value.strip()


def prepare_document(body: FurnitureQuotationInput, now: str, previous: dict | None = None) -> dict:
    """Persist rates on each receipt; subsequent edits cannot alter old rates implicitly."""
    previous = previous or {}
    def entries(values, key):
        old = {entry["id"]: entry for entry in previous.get(key, [])}
        result, seen = [], set()
        for value in values:
            fields = value.model_dump(exclude={"id"})
            if key == "charges":
                fields["amount_rmb"] = decimal_text(money(value.amount_rmb))
            else:
                amount, rate = money(value.amount), money(value.rate)
                if value.currency == "RMB" and rate != 1:
                    raise HTTPException(422, "RNB deposits must use rate 1")
                fields["amount"] = format(amount, "f")
                fields["rate"] = format(rate, "f")
                fields["amount_rmb"] = decimal_text(amount / rate if value.currency == "INR" else amount * rate)
            if Decimal(fields["amount_rmb"]) <= 0:
                raise HTTPException(422, "Each charge and converted deposit must be at least RNB 0.01")
            entry_id = value.id or str(uuid4())
            if entry_id in seen or (value.id and entry_id not in old):
                raise HTTPException(422, "Entry IDs must be unique and belong to this quotation")
            seen.add(entry_id)
            prior = old.get(entry_id, {})
            unchanged = all(prior.get(k) == v for k, v in fields.items())
            result.append({**fields, "id": entry_id, "created_at": prior.get("created_at", now),
                           "updated_at": prior.get("updated_at", now) if unchanged else now})
        return result
    charges, deposits = entries(body.charges, "charges"), entries(body.deposits, "deposits")
    if previous.get("status") == "final":
        if (body.status != "final" or body.customer_name != previous["customer_name"]
                or body.customer_phone != previous["customer_phone"] or charges != previous["charges"]):
            raise HTTPException(409, "Finalized quotation charges and customer details are locked. Deposits can still be updated.")
    payable = sum((Decimal(row["amount_rmb"]) for row in charges), Decimal(0))
    received = sum((Decimal(row["amount_rmb"]) for row in deposits), Decimal(0))
    return {"customer_name": body.customer_name, "customer_phone": body.customer_phone,
            "charges": charges, "deposits": deposits, "status": body.status,
            "total_payable_rmb": decimal_text(payable), "total_received_rmb": decimal_text(received),
            "balance_rmb": decimal_text(payable - received), "updated_at": now,
            "finalized_at": previous.get("finalized_at") or (now if body.status == "final" else None)}


def _date(value: str) -> str:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(ZoneInfo("Asia/Kolkata")).strftime("%d-%m-%Y %H:%M")


def build_pdf(doc: dict) -> tuple[bytes, str]:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Table, TableStyle
    out = BytesIO()
    page = SimpleDocTemplate(out, pagesize=landscape(A4), rightMargin=24, leftMargin=24, topMargin=28, bottomMargin=28, invariant=1)
    text = ParagraphStyle("ledger", fontName="Helvetica", fontSize=9, leading=12)
    paragraph = lambda value: Paragraph(escape(str(value)), text)
    heading = ParagraphStyle("heading", parent=text, alignment=1, fontSize=12)
    rows = [[Paragraph(escape(doc["customer_name"]), heading), "", "", "", "", "", ""],
            ["RNB", "DESCRIPTION", "RNB", "DESCRIPTION", "AMOUNT", "RATE", "DATE"]]
    for i in range(max(len(doc["charges"]), len(doc["deposits"]), 5)):
        charge = doc["charges"][i] if i < len(doc["charges"]) else {}
        deposit = doc["deposits"][i] if i < len(doc["deposits"]) else {}
        dates = sorted({entry["updated_at"] for entry in (charge, deposit) if entry})
        rows.append([charge.get("amount_rmb", ""), paragraph(charge.get("description", "")),
                     deposit.get("amount_rmb", ""), paragraph(deposit.get("description", "")),
                     paragraph(f"{deposit.get('amount', '')} {furniture_currency_label(deposit.get('currency', ''))}".strip()),
                     deposit.get("rate", ""), paragraph(" / ".join(_date(date) for date in dates))])
    total_row = len(rows)
    rows.append([doc["total_payable_rmb"], "", doc["total_received_rmb"], "TOTAL", "", "", ""])
    rows.append(["", "", doc["balance_rmb"], "BALANCE AMOUNT", "", "", ""])
    table = Table(rows, colWidths=[85, 130, 85, 145, 90, 65, 193 / 2], repeatRows=2)
    table.setStyle(TableStyle([
        ("SPAN", (0, 0), (-1, 0)), ("ALIGN", (0, 0), (-1, 0), "CENTER"),
        ("BACKGROUND", (0, 1), (-1, 1), colors.HexColor("#c7c9ef")),
        ("BACKGROUND", (0, total_row), (-1, total_row), colors.HexColor("#fff000")),
        ("BACKGROUND", (2, total_row + 1), (3, total_row + 1), colors.HexColor("#ffaf00")),
        ("GRID", (0, 0), (-1, -1), .5, colors.HexColor("#777777")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("ALIGN", (0, 2), (0, -1), "RIGHT"),
        ("ALIGN", (2, 2), (2, -1), "RIGHT"), ("FONTNAME", (0, 1), (-1, 1), "Helvetica-Bold"),
        ("TOPPADDING", (0, 0), (-1, -1), 9), ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ]))
    from services.referrer_identity import referrer_label
    reference = referrer_label(doc)
    header = [paragraph(f"Architect / interior designer: {reference}")] if reference else []
    if doc.get("referrer_company"):
        header.append(paragraph(doc["referrer_company"]))
    page.build([*header, table])
    return out.getvalue(), f"Furniture-{doc['id']}.pdf"
