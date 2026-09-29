from services.po_final import build_po_final
from services.po_final_pdf import build_po_final_pdf
from services.godown_valuation import transferred_sold_value
from routes.po_final_routes import _linked_loan_items


def test_po_final_uses_customer_quote_prices_and_records_movements():
    customer = {"id": "c1", "name": "Vitra", "floor_id": "first-floor"}
    old_line = {"id": "l1", "product_id": "p1", "sku": "B-1", "name": "Basin", "qty": 1, "unit_price": 100}
    new_line = {**old_line, "qty": 2}
    quotation = {
        "id": "q1", "number": "FQ-1", "status": "ordered", "grand_total": 180,
        "items": [new_line], "project_discount_pct": 10,
        "revisions": [{"id": "rev1", "created_at": "2026-09-01T10:00:00Z",
                       "snapshot": {"items": [old_line], "grand_total": 90}, "reason": "Quantity updated"}],
        "payment_extra_amount": 999,
        "payment_extra_history": [{"id": "cost1", "created_at": "2026-09-02T10:00:00Z", "name": "Transport", "amount": 20}],
    }
    po = {"id": "po1", "items": [{"quotation_line_id": "l1", "unit_cost": 12,
                                   "stage": "at_godown", "borrowed_from_customer_id": "c2"}]}
    event = {"id": "e1", "created_at": "2026-09-03T10:00:00Z", "event_type": "purchase.borrowed_in",
             "summary": "Borrowed 1 × Basin from another customer", "payload": {"qty": 1}}
    result = build_po_final(customer, quotation, [quotation], [po], [event])

    assert result["items"][0]["total"] == 180
    assert result["items"][0]["unit_price"] == 90
    assert result["items"][0]["list_unit_price"] == 100
    assert result["items"][0]["source"] == "customer_loan"
    assert result["total"] == 180
    assert result["payable_total"] == 200
    assert any(c["type"] == "amount_adjusted" and c["amount"] == 90 for c in result["changes"])
    assert any(c["type"] == "purchase.borrowed_in" for c in result["changes"])
    assert all(c["quotation_id"] == "q1" for c in result["changes"])
    assert build_po_final_pdf(result).startswith(b"%PDF-")


def test_po_final_partial_and_full_godown_moves_reduce_sale_once():
    customer = {"id": "c1", "name": "Vitra", "floor_id": "first-floor"}
    quotation = {"id": "q1", "number": "FQ-1", "status": "ordered", "grand_total": 500,
                 "items": [
                     {"id": "a", "product_id": "p1", "sku": "A", "name": "Basin", "qty": 3, "unit_price": 100},
                     {"id": "b", "product_id": "p2", "sku": "B", "name": "Tap", "qty": 2, "unit_price": 100},
                 ]}
    pos = [{"id": "po1", "items": [
        {"quotation_line_id": "a", "qty": 2, "unit_cost": 100, "godown_transferred_qty": 1},
        {"quotation_line_id": "a", "qty": 1, "unit_cost": 100, "godown_transferred_qty": 0,
         "loan_replenishment_returned_qty": 1},
        {"quotation_line_id": "b", "qty": 2, "unit_cost": 100, "godown_transferred_qty": 2},
    ]}]
    result = build_po_final(customer, quotation, [quotation], pos, [])

    assert [(line["qty"], line["total"]) for line in result["items"]] == [(2, 200), (0, 0)]
    assert result["godown_credit_amount"] == 300
    assert result["original_total"] == 500
    assert result["total"] == 200
    assert result["payable_total"] == 200
    assert sum(line["total"] for line in result["items"]) == result["total"]
    assert len([c for c in result["changes"] if c["type"] == "godown_stock.final_adjustment"]) == 2


def test_po_final_loan_return_does_not_reduce_sale_and_overmove_never_goes_negative():
    customer = {"id": "c1", "name": "Vitra", "floor_id": "first-floor"}
    quotation = {"id": "q1", "number": "FQ-1", "status": "ordered", "grand_total": 200,
                 "items": [{"id": "a", "product_id": "p1", "sku": "A", "name": "Basin", "qty": 2, "unit_price": 100}]}
    loan = [{"id": "po1", "items": [{"quotation_line_id": "a", "qty": 2, "unit_cost": 100,
                                       "loan_replenishment_returned_qty": 2}]}]
    result = build_po_final(customer, quotation, [quotation], loan, [])
    assert (result["items"][0]["qty"], result["items"][0]["total"], result["total"]) == (2, 200, 200)

    overmove = [{"id": "po1", "items": [{"quotation_line_id": "a", "qty": 2, "unit_cost": 100,
                                           "godown_transferred_qty": 3}]}]
    result = build_po_final(customer, quotation, [quotation], overmove, [])
    assert (result["items"][0]["qty"], result["items"][0]["total"], result["total"]) == (0, 0, 0)


def test_repriced_quote_uses_value_captured_at_godown_transfer():
    quote = {"id": "q1", "number": "FQ-1", "status": "ordered", "grand_total": 300,
             "items": [{"id": "line", "product_id": "product", "sku": "A", "name": "Basin",
                        "qty": 2, "unit_price": 150}]}
    po = {"id": "po1", "items": [{"quotation_line_id": "line", "qty": 2,
                                   "unit_cost": 100, "godown_transferred_qty": 1,
                                   "godown_valued_qty": 1, "godown_transferred_value": 150}]}
    result = build_po_final({"id": "c1", "name": "Customer"}, quote, [quote], [po], [])
    assert (result["total"], result["items"][0]["qty"], result["items"][0]["unit_price"]) == (150, 1, 150)
    assert transferred_sold_value({"godown_transferred_qty": 2, "godown_valued_qty": 1,
                                   "godown_transferred_value": 150, "unit_cost": 100}) == 250


def test_loan_linking_uses_exact_replenishment_item():
    selected = [{"id": "recipient-po", "items": [
        {"id": "ordered-item", "quotation_line_id": "selected-line"},
        {"id": "other-item", "quotation_line_id": "other-line"},
    ]}]
    source = [{"items": [{"customer_loan_history": [
        {"transfer_id": "loan-a", "replenishment_po_id": "recipient-po", "replenishment_item_id": "ordered-item"},
        {"transfer_id": "loan-b", "replenishment_po_id": "different-po", "replenishment_item_id": "ordered-item"},
    ]}]}]
    assert _linked_loan_items(source, selected) == {"loan-a": "selected-line"}
