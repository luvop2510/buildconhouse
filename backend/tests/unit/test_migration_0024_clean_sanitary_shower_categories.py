"""Examples from the live supplier catalog protect shower category boundaries."""
import importlib


target_for = importlib.import_module("migrations.0024_clean_sanitary_shower_categories").target_for


def test_grohe_shower_heads_remain_and_other_parts_leave():
    assert target_for("Grohe", "SHOWER", "Rainshower 310 Mono Cube Headshower Set") is None
    assert target_for("Grohe", "SHOWER", "Rainshower SmartActive 130 Hand Shower") == "HAND SHOWER SET"
    assert target_for("Grohe", "SHOWER", "Rainshower SmartActive Shower Rail 600mm") == "HAND SHOWER SET"
    assert target_for("Grohe", "SHOWER", "New Tempesta-F Trigger Spray") == "TRIGGER"
    assert target_for("Grohe", "SHOWER", "Extension cable- 5m Light Set") == "Accessories"
    assert target_for("Grohe", "HAND SHOWER SET", "Silverflex Shower Hose, 1500 mm") == "Accessories"
    assert target_for("Grohe", "HAND SHOWER SET", "Tempesta 110 wall holder set 2-spray") is None


def test_hansgrohe_axor_and_vitra_are_brand_scoped():
    assert target_for("Hansgrohe", "SHOWERS", "HG shower arm E 390mm chrome") == "Holder"
    assert target_for("Axor", "Showers", "AX shower arm chrome") == "Holder"
    assert target_for("Axor", "Showers", "AX AXOR One Overhead shower 280 2jet with shower arm Chrome") is None
    assert target_for("Hansgrohe", "SHOWERS", "HG Rainfinity 360 OHS wall chrome") is None
    assert target_for("Vitra", "Showers", "ISTANBUL SHOWER SYSTEMS BASIN MIXER", "Basin Mixer") == "Faucets"
    assert target_for("Geberit", "Flush Plates", "Sigma plate") is None
