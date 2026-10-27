import type { BuilderRow, BuilderState, Line } from "./types";

/** Move a product with its included parts, or a complete visible room section. */
export function moveQuotationRows(rows: BuilderRow[], id: string, targetIndex: number): BuilderRow[] {
  const source = rows.find(row => row.id === id);
  if (!source || (source.kind === "line" && source.line.included_for_line_id)) return rows;
  let moving: BuilderRow[];
  if (source.kind === "room-header") {
    const start = rows.indexOf(source);
    const following = rows.findIndex((row, index) => index > start && row.kind === "room-header");
    moving = rows.slice(start, following < 0 ? rows.length : following);
  } else {
    moving = rows.filter(row => row.id === id || (row.kind === "line" && row.line.included_for_line_id === id));
  }
  const movingIds = new Set(moving.map(row => row.id));
  const rest = rows.filter(row => !movingIds.has(row.id));
  // A product must always remain below a room heading.
  let index = Math.max(source.kind === "line" ? 1 : 0, Math.min(rest.length, targetIndex));
  // Sections can only be inserted before another heading or after the last
  // section, never through the middle of that section's products.
  if (source.kind === "room-header") {
    while (index < rest.length && rest[index].kind !== "room-header") index += 1;
  }
  const next = [...rest.slice(0, index), ...moving, ...rest.slice(index)];
  return next.every((row, i) => row.id === rows[i]?.id) ? rows : next;
}

/** Apply a visible reorder without losing products inside collapsed rooms. */
export function applyQuotationRowOrder(state: BuilderState, rows: BuilderRow[]): BuilderState {
  const rooms = rows.filter(row => row.kind === "room-header").map(row => row.roomName);
  const roomOrder = [...new Set([...rooms, ...state.rooms])].filter(room => state.rooms.includes(room));
  // Native lists drag a header as one row. Its products stay in their original
  // section even though the transient row order puts them before that header.
  if (roomOrder.some((value, i) => value !== state.rooms[i])) {
    const knownRooms = new Set(roomOrder);
    const lines = roomOrder.flatMap(room => state.lines.filter(line => (knownRooms.has(line.room || "") ? line.room : roomOrder[0]) === room));
    return { ...state, rooms: roomOrder, lines };
  }
  const byId = new Map(state.lines.map(line => [line.id, line]));
  const assigned: Line[] = [];
  const seen = new Set<string>();
  let room = roomOrder[0];
  const add = (line: Line, targetRoom: string) => {
    if (seen.has(line.id)) return;
    seen.add(line.id);
    assigned.push(line.room === targetRoom ? line : { ...line, room: targetRoom });
  };
  for (const row of rows) {
    if (row.kind === "room-header") {
      room = row.roomName;
      if (state.collapsedRooms[room]) {
        state.lines.filter(line => line.room === room).forEach(line => add(line, room));
      }
    } else {
      const line = byId.get(row.id);
      if (line && room) add(line, room);
    }
  }
  // Defensive preservation for interrupted drags or stale virtualized rows.
  for (const line of state.lines) if (!seen.has(line.id)) add(line, line.room || roomOrder[0]);
  const roots = assigned.filter(line => !line.included_for_line_id);
  const children = new Map<string, Line[]>();
  for (const line of assigned) {
    if (line.included_for_line_id) {
      const group = children.get(line.included_for_line_id) || [];
      group.push(line);
      children.set(line.included_for_line_id, group);
    }
  }
  const lines = roots.flatMap(line => [line, ...(children.get(line.id) || []).map(child => child.room === line.room ? child : { ...child, room: line.room })]);
  // Retain orphaned legacy parts rather than deleting business history.
  const rootIds = new Set(roots.map(line => line.id));
  lines.push(...assigned.filter(line => line.included_for_line_id && !rootIds.has(line.included_for_line_id)));
  if (lines.every((line, i) => line === state.lines[i]) && roomOrder.every((value, i) => value === state.rooms[i])) return state;
  return { ...state, rooms: roomOrder, lines };
}

/** Keyboard/button ordering uses the same product-group boundaries as drag. */
export function moveQuotationLine(lines: Line[], id: string, direction: -1 | 1): Line[] {
  const source = lines.find(line => line.id === id);
  if (!source || source.included_for_line_id) return lines;
  const peers = lines.filter(line => line.room === source.room && !line.included_for_line_id);
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
