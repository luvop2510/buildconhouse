"""The saved room and product order shared by quotation exports."""


def _sort_key(entry: tuple[int, dict]) -> tuple[int, int]:
    position, item = entry
    try:
        return int(item.get("sort_order", position)), position
    except (TypeError, ValueError, OverflowError):
        return position, position


def ordered_room_items(items: list[dict], rooms: list[str] | None) -> dict[str, list[tuple[int, dict]]]:
    grouped: dict[str, list[tuple[int, dict]]] = {}
    for position, item in enumerate(items):
        grouped.setdefault(item.get("room") or "General", []).append((position, item))
    room_order = dict.fromkeys([*(rooms or []), *grouped])
    return {room: sorted(grouped[room], key=_sort_key) for room in room_order if room in grouped}
