"""Compact vector graphics drawn only from the selected report sections."""
from math import cos, isfinite, pi, sin

from reportlab.graphics.shapes import Circle, Drawing, Line, PolyLine, Rect, String
from reportlab.lib import colors
from reportlab.pdfbase.pdfmetrics import stringWidth

from pdf_generator import RUPEE_FONT
from services.money import format_indian_money

INK = colors.HexColor('#1D1D1F')
MARK = colors.HexColor('#0066CC')
MUTED = colors.HexColor('#626267')
LINE = colors.HexColor('#E2E2E7')
WASH = colors.HexColor('#F5F5F7')
FACE = RUPEE_FONT or 'Helvetica'


def numeric(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and isfinite(value)


def fitted(value, width, size=8):
    text = str(value)
    while text and stringWidth(text, FACE, size) > width:
        text = text[:-1]
    return text if text == str(value) else text[:-3] + '...'


def amount(value, currency):
    return f'{currency} {format_indian_money(value)}' if numeric(value) else 'Unavailable'


def collection_arc(collected, outstanding, currency, width):
    if not all(numeric(value) and value >= 0 for value in (collected, outstanding)):
        return None
    total = collected + outstanding
    if not numeric(total) or total <= 0:
        return None
    share = collected / total
    d = Drawing(width, 113)
    center, base, radius = width / 2, 29, min(48, width / 2 - 13)
    def points(fraction):
        return [coordinate for step in range(49) for coordinate in (center + radius * cos(pi - pi * fraction * step / 48), base + radius * sin(pi - pi * fraction * step / 48))]
    d.add(String(center, 99, f'{currency} collected share', textAnchor='middle', fontName=FACE, fontSize=9, fillColor=INK))
    d.add(PolyLine(points(1), strokeColor=LINE, strokeWidth=8, strokeLineCap=1))
    if share > 0:
        d.add(PolyLine(points(share), strokeColor=MARK, strokeWidth=8, strokeLineCap=1))
    d.add(String(center, 39, f'{share * 100:.1f}%', textAnchor='middle', fontName=FACE, fontSize=18, fillColor=INK))
    d.add(String(center - radius, 15, '0%', textAnchor='middle', fontName=FACE, fontSize=7, fillColor=MUTED))
    d.add(String(center + radius, 15, '100%', textAnchor='middle', fontName=FACE, fontSize=7, fillColor=MUTED))
    d.add(String(center, 1, 'Receipts / (receipts + outstanding)', textAnchor='middle', fontName=FACE, fontSize=6.5, fillColor=MUTED))
    return d


def trend(rows, currency, width, title="Sales over time"):
    key = 'sales_rnb' if currency == 'RNB' else 'sales'
    prior = 'previous_sales_rnb' if currency == 'RNB' else 'previous_sales'
    values = [row.get(key) for row in rows]
    old = [row.get(prior) for row in rows]
    if not any(numeric(value) for value in values):
        return None
    d = Drawing(width, 150)
    left, right, bottom, top = 42, width - 12, 30, 120
    upper = max(1, *(value for value in values + old if numeric(value)))
    lower = min(0, *(value for value in values + old if numeric(value)))
    span = upper - lower
    x = lambda index: left + (index + .5) * (right - left) / max(1, len(rows))
    y = lambda value: bottom + (value - lower) / span * (top - bottom)
    d.add(String(0, 138, f'{currency} / {title.lower()}', fontName=FACE, fontSize=10, fillColor=INK))
    for ratio in (0, .5, 1):
        value = lower + span * ratio
        axis = f'{value / 100000:.1f}L' if abs(value) >= 100000 else f'{value / 1000:.0f}k' if abs(value) >= 1000 else f'{value:g}'
        d.add(Line(left, y(value), right, y(value), strokeColor=LINE, strokeWidth=.5))
        d.add(String(left - 5, y(value) - 3, axis, fontName=FACE, fontSize=7, textAnchor='end', fillColor=MUTED))
    bar_width = min(16, (right - left) / max(1, len(rows)) * .6)
    for i, value in enumerate(values):
        if numeric(value):
            d.add(Rect(x(i) - bar_width / 2, min(y(0), y(value)), bar_width, abs(y(value) - y(0)), fillColor=MARK, strokeColor=None))
    run = []
    for i, value in enumerate(old + [None]):
        if numeric(value):
            run += [x(i), y(value)]
        else:
            if len(run) >= 4:
                d.add(PolyLine(run, strokeColor=MUTED, strokeWidth=1, strokeDashArray=[3, 2]))
            elif len(run) == 2:
                d.add(Circle(*run, 2, fillColor=MUTED, strokeColor=None))
            run = []
    for i in sorted({0, len(rows) // 2, len(rows) - 1}):
        d.add(String(x(i), 16, fitted(rows[i].get('label', rows[i].get('date', '')), 68, 7), fontName=FACE, fontSize=7, textAnchor='middle', fillColor=MUTED))
    legend = 'Columns: selected period'
    if any(numeric(value) for value in old):
        legend += ' / dashed: previous period'
    if any(not numeric(value) for value in values):
        legend += ' / gaps: unavailable'
    d.add(String(left, 2, legend, fontName=FACE, fontSize=7, fillColor=MUTED))
    return d


def ranking(rows, field, currency, width, title):
    # Never compare money across currencies or unlike units.
    eligible = [row for row in rows if numeric(row.get(field)) and (currency is None or ('RNB' if field.endswith('_rnb') else row.get('currency', 'INR')) == currency)]
    if len(eligible) < 2:
        return None
    shown = sorted(eligible, key=lambda row: -row[field])[:5]
    lower = min(0, *(row[field] for row in shown))
    upper = max(0, *(row[field] for row in shown))
    span = upper - lower
    d = Drawing(width, 34 + 24 * len(shown))
    unit = currency or field.replace('_', ' ')
    d.add(String(0, d.height - 10, fitted(f'{title} / {unit}', width, 9), fontName=FACE, fontSize=9, fillColor=INK))
    for i, row in enumerate(shown):
        y = d.height - 29 - i * 24
        name = next((row.get(key) for key in ('name', 'number', 'label', 'customer_name', 'id') if row.get(key)), 'Recorded row')
        value = amount(row[field], currency) if currency else f'{row[field]:g}'
        d.add(String(0, y, fitted(str(name).split('\n')[0], width * .52, 7.5), fontName=FACE, fontSize=7.5, fillColor=INK))
        d.add(String(width, y, value, textAnchor='end', fontName=FACE, fontSize=7.5, fillColor=INK))
        d.add(Rect(0, y - 9, width, 4, fillColor=WASH, strokeColor=None))
        if span:
            zero, point = width * -lower / span, width * (row[field] - lower) / span
            d.add(Rect(min(zero, point), y - 9, abs(point - zero), 4, fillColor=MARK, strokeColor=None))
    d.add(String(0, 1, f'Top {len(shown)} of {len(rows)} rows / zero-based scale', fontName=FACE, fontSize=6.5, fillColor=MUTED))
    return d


def cell_bar(value, lower, upper, width):
    d = Drawing(width, 5)
    d.add(Rect(0, 1, width, 3, fillColor=WASH, strokeColor=None))
    if numeric(value) and upper > lower:
        zero, point = width * -lower / (upper - lower), width * (value - lower) / (upper - lower)
        d.add(Rect(min(zero, point), 1, abs(point - zero), 3, fillColor=MARK, strokeColor=None))
    return d
