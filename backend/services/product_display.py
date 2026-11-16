"""Presentation-only names for tables with a dedicated size column."""
import re


def tile_product_name(name, size):
    name = str(name or "")
    normalize = lambda value: re.sub(r"\s", "", str(value or "")).replace("×", "x").replace("*", "x").lower()
    dimension = normalize(size)
    if not re.fullmatch(r"\d+(?:\.\d+)?(?:mm|cm|m|in)?x\d+(?:\.\d+)?(?:mm|cm|m|in)?(?:x\d+(?:\.\d+)?(?:mm|cm|m|in)?)?", dimension):
        return name
    def bracket(match):
        return "" if normalize(match.group(1) or match.group(2)) == dimension else match.group(0)
    without_brackets = re.sub(r"\(([^()]*)\)|\[([^\[\]]*)\]", bracket, name)
    tokens = [re.escape(token) for token in dimension.split("x")]
    suffix = r"(?:\s+|\s*[-–—,:]\s*)" + r"\s*[x×*]\s*".join(tokens) + r"\s*$"
    cleaned = re.sub(suffix, "", without_brackets, flags=re.I)
    return name if cleaned == name else re.sub(r"[ \t]{2,}", " ", cleaned).strip() or name
