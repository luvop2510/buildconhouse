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


def wc_seat_links(items: list[dict]) -> dict[str, str | None]:
    parents = {item["id"]: str(item.get("sku") or "") for item in items
               if item.get("id") and not item.get("included_for_line_id")}
    links: dict[str, str | None] = {}
    for item in items:
        parent_id = item.get("included_for_line_id")
        if item.get("id") and item.get("included_part_role") == "seat_cover" and parent_id in parents:
            links[parent_id] = None
            links[item["id"]] = parents[parent_id]
    return links


def quotation_item_description(item: dict, wc_seats: dict[str, str | None]) -> str:
    name = item.get("name") or ""
    description = item.get("description")
    line_id = item.get("id")
    status = item.get("availability")
    if line_id not in wc_seats and not status:
        return str(description or name)
    # Keep article identity and availability visible ahead of longer supplier copy.
    wc_article = wc_seats.get(line_id)
    return " | ".join(str(value) for value in (
        name, f"Seat cover for {wc_article}" if wc_article else None, status,
        description if description != name else None,
    ) if value)
