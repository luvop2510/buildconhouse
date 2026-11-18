import type { BuilderRow, BuilderState, Line } from "./types";

/** Preview a drag in the active workspace without separating included parts. */
export function moveQuotationRows(rows: BuilderRow[], id: string, targetIndex: number): BuilderRow[] {
  const source = rows.find(row => row.id === id);
  if (source?.kind !== "line" || source.line.included_for_line_id) return rows;

  const moving = rows.filter(row => row.id === id || (row.kind === "line" && row.line.included_for_line_id === id));
  const movingIds = new Set(moving.map(row => row.id));
  const rest = rows.filter(row => !movingIds.has(row.id));
  let index = Math.max(1, Math.min(rest.length, targetIndex));
  while (index < rest.length) {
    const row = rest[index];
    if (row.kind !== "line" || !row.line.included_for_line_id) break;
    index += 1;
  }
  const next = [...rest.slice(0, index), ...moving, ...rest.slice(index)];
  return next.every((row, i) => row.id === rows[i]?.id) ? rows : next;
}

/** Reorder only the active room, preserving all other line slots and identities. */
export function reorderQuotationRoom(state: BuilderState, room: string, orderedIds: string[]): BuilderState {
  const belongs = (line: Line) => (line.room && state.rooms.includes(line.room) ? line.room : state.rooms[0]) === room;
  const current = state.lines.filter(belongs);
  const byId = new Map(current.map(line => [line.id, line]));
  const ordered = orderedIds.flatMap(id => {
    const line = byId.get(id);
    if (!line) return [];
    byId.delete(id);
    return [line];
  });
  // A stale gesture cannot overwrite a newly added or removed product.
  if (byId.size || ordered.length !== current.length) return state;
  const children = new Map<string, Line[]>();
  const roots = new Set(ordered.filter(line => !line.included_for_line_id).map(line => line.id));
  for (const line of ordered) {
    const parent = line.included_for_line_id;
    if (!parent || !roots.has(parent)) continue;
    const group = children.get(parent) || [];
    group.push(line);
    children.set(parent, group);
  }
  const grouped = ordered.flatMap(line => {
    if (line.included_for_line_id && roots.has(line.included_for_line_id)) return [];
    return [line, ...(children.get(line.id) || [])];
  });
  if (grouped.every((line, i) => line === current[i])) return state;
  let index = 0;
  return { ...state, lines: state.lines.map(line => belongs(line) ? grouped[index++] : line) };
}

/** Keyboard ordering moves one selected product with its included parts. */
export function moveQuotationLine(lines: Line[], id: string, direction: -1 | 1, roomOf = (line: Line) => line.room): Line[] {
  const source = lines.find(line => line.id === id);
  if (!source || source.included_for_line_id) return lines;
  const room = roomOf(source);
  const peers = lines.filter(line => roomOf(line) === room && !line.included_for_line_id);
  const target = peers[peers.indexOf(source) + direction];
  if (!target) return lines;
  const group = lines.filter(line => line.id === id || line.included_for_line_id === id);
  const rest = lines.filter(line => !group.includes(line));
  let index = rest.indexOf(target);
  if (direction > 0) {
    index += 1;
    while (rest[index]?.included_for_line_id === target.id) index += 1;
  }
  return [...rest.slice(0, index), ...group, ...rest.slice(index)];
}
