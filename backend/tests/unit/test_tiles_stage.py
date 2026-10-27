"""Direct tile workflow preserves legacy documents without approval gates."""
import pytest
from services.tiles_stage import can_move_to_quotation, can_place_order, next_tiles_action, tiles_stage, tiles_stage_label

@pytest.mark.parametrize("status", ["draft", "pending_approval", "approved", "sent", "won"])
def test_every_editable_selection_moves_directly_to_quotation(status):
    assert tiles_stage("tiles_selection", status) == "selection_draft"
    assert tiles_stage_label("tiles_selection", status) == "Selection — Draft"
    assert can_move_to_quotation("tiles_selection", status)
    assert next_tiles_action("tiles_selection", status) == {"label": "Move to Quotation", "kind": "move_to_quotation", "next_status": None}
    assert not can_place_order("tiles_selection", status)

@pytest.mark.parametrize("status", ["draft", "pending_approval", "approved", "sent", "won"])
def test_every_editable_quotation_can_place_order_without_confirmation(status):
    assert tiles_stage("tiles_quotation", status) == "quotation_draft"
    assert can_place_order("tiles_quotation", status)
    assert not can_move_to_quotation("tiles_quotation", status)
    assert next_tiles_action("tiles_quotation", status) is None

@pytest.mark.parametrize("doc_type", ["tiles_selection", "tiles_quotation"])
def test_ordered_or_closed_documents_offer_no_new_workflow_action(doc_type):
    assert not can_move_to_quotation(doc_type, "ordered")
    assert not can_place_order(doc_type, "ordered")
    assert not can_place_order(doc_type, "lost")
    assert next_tiles_action(doc_type, "ordered") is None

def test_standard_quotation_workflow_is_unchanged():
    assert can_place_order("standard", "draft")
    assert can_place_order("standard", "approved")
    with pytest.raises(ValueError):
        tiles_stage("standard", "draft")
