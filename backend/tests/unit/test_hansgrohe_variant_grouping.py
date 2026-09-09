"""Finish normalization must not split an AXOR/Hansgrohe product family."""

from catalog_pipeline.adapters.hansgrohe import _base_name, _detect_finish, canonical_hansgrohe_sku


def test_brushed_brass_is_a_finish_not_part_of_the_hansgrohe_family_name():
    name = "AX AXOR One Basin mixer for concealed installation wall-mounted Select with spout 220 mm Brushed Brass"

    finish, code = _detect_finish(name, "48112950")

    assert (finish, code) == ("Brushed Brass", "BR")
    assert _base_name(name, "AXOR One", finish) == "Basin mixer for concealed installation wall-mounted Select with spout 220 mm"


def test_hansgrohe_numeric_article_numbers_restore_only_the_lost_initial_zero():
    assert canonical_hansgrohe_sku(1800187) == "01800187"
    assert canonical_hansgrohe_sku("1500180") == "01500180"
    assert canonical_hansgrohe_sku("26456000-2") == "26456000-2"
    assert canonical_hansgrohe_sku("26456000") == "26456000"
