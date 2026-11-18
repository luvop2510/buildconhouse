// Pointer-based ordering works with mouse, pen and touch without native gestures.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { ScrollView } from "react-native";

import { radius, spacing } from "@/src/theme/tokens";

import { useBuilder } from "../context/BuilderContext";
import { moveQuotationRows } from "../helpers/reorder";
import type { BuilderRow } from "../helpers/types";
import { EmptyRoom } from "./EmptyRoom";
import { LineRow } from "./LineRow";
import { RoomHeaderRow } from "./RoomHeaderRow";

type Drag = {
  id: string; movingIds: Set<string>;
  pointerId: number; y: number; startY: number; started: boolean; grabOffset: number;
  capture: HTMLElement; scroll: HTMLElement | null; changed: boolean;
  lastY: number | null; lastScrollTop: number | null;
};

export function QuotationCanvas({ compact = false, scrollHeader }: { compact?: boolean; scrollHeader?: ReactNode }) {
  const b = useBuilder();
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [orderMessage, setOrderMessage] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<BuilderRow[] | null>(null);
  const previewRef = useRef<BuilderRow[] | null>(null);
  const previousPositions = useRef(new Map<string, number>());
  const animations = useRef(new Map<string, Animation>());
  const commitRef = useRef(b.onLinesDragEnd);
  commitRef.current = b.onLinesDragEnd;
  const rows = preview || b.flatRows;
  const getRows = () => Array.from(root.current?.querySelectorAll<HTMLElement>("[data-quotation-row]") || []);

  // Also run at release: a quick gesture can begin and finish between frames.
  const updateDrag = () => {
    const current = drag.current;
    const container = root.current;
    if (!current || !container) return;
    current.started ||= Math.abs(current.y - current.startY) >= 5;
    if (!current.started) return;
    const elements = getRows();
    const byId = new Map(elements.map(element => [element.dataset.quotationRow!, element]));
    const active = byId.get(current.id);
    if (!active) return;
    const top = container.getBoundingClientRect().top;
    const currentRows = previewRef.current || [];
    const rowsById = new Map(currentRows.map(row => [row.id, row]));
    // React may not have reconciled the latest preview yet. Read candidate
    // order and geometry together from the same rendered DOM snapshot.
    const candidates = elements.flatMap(element => {
      const row = rowsById.get(element.dataset.quotationRow!);
      return row && !current.movingIds.has(row.id) ? [row] : [];
    });
    const scrollTop = current.scroll?.scrollTop || 0;
    const moved = current.lastY !== current.y || current.lastScrollTop !== scrollTop;
    current.lastY = current.y;
    current.lastScrollTop = scrollTop;
    let target = candidates.length;
    for (let i = 0; i < candidates.length; i += 1) {
      const row = candidates[i];
      const element = byId.get(row.id);
      if (element && current.y < top + element.offsetTop + element.offsetHeight / 2) { target = i; break; }
    }
    const next = moved ? moveQuotationRows(currentRows, current.id, target) : currentRows;
    if (next !== previewRef.current) {
      previousPositions.current = new Map(elements.map(element => [element.dataset.quotationRow!, element.offsetTop]));
      previewRef.current = next;
      current.changed = true;
      setPreview(next);
    }
    const displacement = current.y - current.grabOffset - top - active.offsetTop;
    for (const id of current.movingIds) {
      const element = byId.get(id);
      if (element) element.style.transform = `translateY(${displacement}px)`;
    }
  };

  const finish = (cancel = false) => {
    const current = drag.current;
    if (!current) return;
    if (!cancel) updateDrag();
    drag.current = null;
    if (current.capture.hasPointerCapture(current.pointerId)) current.capture.releasePointerCapture(current.pointerId);
    getRows().forEach(element => { element.style.transform = ""; });
    animations.current.forEach(animation => animation.cancel());
    animations.current.clear();
    if (!cancel && current.changed && previewRef.current) commitRef.current({ data: previewRef.current });
    previewRef.current = null;
    setPreview(null);
    setDraggingId(null);
  };

  // FLIP displacement keeps the surrounding products sliding into their new slots.
  useLayoutEffect(() => {
    const current = drag.current;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const element of getRows()) {
      const id = element.dataset.quotationRow!;
      const previous = previousPositions.current.get(id);
      if (current && !current.movingIds.has(id) && previous !== undefined && previous !== element.offsetTop && !reducedMotion) {
        animations.current.get(id)?.cancel();
        const animation = element.animate([
          { transform: `translateY(${previous - element.offsetTop}px)` }, { transform: "translateY(0)" },
        ], { duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
        animations.current.set(id, animation);
      }
    }
  }, [rows]);

  useEffect(() => {
    if (!draggingId) return;
    let frame = 0;
    let previousTime = performance.now();
    const tick = (now: number) => {
      const elapsed = Math.min(64, Math.max(0, now - previousTime));
      previousTime = now;
      const current = drag.current;
      const container = root.current;
      if (!current || !container) return;
      if (!getRows().some(element => element.dataset.quotationRow === current.id)) { finish(true); return; }
      current.started ||= Math.abs(current.y - current.startY) >= 5;
      if (current.started && current.scroll) {
        const viewport = window.visualViewport;
        const viewportTop = viewport?.offsetTop || 0;
        const viewportBottom = viewportTop + (viewport?.height || window.innerHeight);
        const documentScroll = current.scroll === document.scrollingElement;
        const rect = documentScroll ? { top: viewportTop, bottom: viewportBottom } : current.scroll.getBoundingClientRect();
        const upper = Math.max(viewportTop, rect.top);
        const lower = Math.min(viewportBottom, rect.bottom);
        const edge = Math.min(64, (lower - upper) / 4);
        const distance = current.y < upper + edge ? -Math.min(24, (upper + edge - current.y) / 2)
          : current.y > lower - edge ? Math.min(24, (current.y - lower + edge) / 2) : 0;
        if (distance) current.scroll.scrollTop += distance * elapsed / (1000 / 60);
      }
      updateDrag();
      frame = requestAnimationFrame(tick);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); finish(true); } };
    frame = requestAnimationFrame(tick);
    window.addEventListener("keydown", onKey);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("keydown", onKey); };
    // The frame reads current rows through refs; rendering a preview must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingId]);

  // An external undo, floor change or restored draft cancels an obsolete gesture.
  useEffect(() => {
    if (drag.current) finish(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b.flatRows]);
  useEffect(() => () => {
    const current = drag.current;
    if (current?.capture.hasPointerCapture(current.pointerId)) current.capture.releasePointerCapture(current.pointerId);
    drag.current = null;
    animations.current.forEach(animation => animation.cancel());
  }, []);

  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current || event.button !== 0 || !event.isPrimary) return;
    const handle = (event.target as Element).closest<HTMLElement>('[data-testid^="line-drag-"]');
    const rowElement = handle?.closest<HTMLElement>("[data-quotation-row]");
    const row = b.flatRows.find(row => row.id === rowElement?.dataset.quotationRow);
    if (row?.kind !== "line" || row.line.included_for_line_id || !rowElement) return;
    event.preventDefault();
    event.stopPropagation();
    let scroll = root.current?.parentElement || null;
    while (scroll && (!/(auto|scroll)/.test(getComputedStyle(scroll).overflowY) || scroll.scrollHeight <= scroll.clientHeight)) scroll = scroll.parentElement;
    scroll ||= document.scrollingElement as HTMLElement | null;
    const movingRows = b.flatRows.filter(item => item.id === row.id || (item.kind === "line" && item.line.included_for_line_id === row.id));
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      id: row.id, movingIds: new Set(movingRows.map(item => item.id)), pointerId: event.pointerId, y: event.clientY, startY: event.clientY, started: false,
      grabOffset: event.clientY - rowElement.getBoundingClientRect().top,
      capture: event.currentTarget, scroll, changed: false, lastY: event.clientY, lastScrollTop: scroll?.scrollTop || 0,
    };
    previewRef.current = b.flatRows;
    previousPositions.current = new Map(getRows().map(element => [element.dataset.quotationRow!, element.offsetTop]));
    setPreview(b.flatRows);
    setDraggingId(row.id);
  };

  return <ScrollView style={{ flex: 1, minHeight: 0 }} keyboardShouldPersistTaps="handled" testID="receipt-list">
    {scrollHeader}
    <div ref={root} style={{ position: "relative", padding: spacing.md, paddingBottom: 32, display: "flex", flexDirection: "column", gap: 6 }}
      onPointerDown={start}
      onPointerMove={event => { if (drag.current?.pointerId === event.pointerId) { event.preventDefault(); drag.current.y = event.clientY; } }}
      onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) { drag.current.y = event.clientY; finish(); } }}
      onPointerCancel={() => finish(true)}
      onLostPointerCapture={() => finish(true)}
      onClickCapture={event => {
        if ((event.target as Element).closest('[data-testid^="line-drag-"]')) {
          event.preventDefault(); event.stopPropagation();
        }
      }}
      onKeyDown={event => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        const handle = (event.target as Element).closest<HTMLElement>('[data-testid^="line-drag-"]');
        const id = handle?.closest<HTMLElement>("[data-quotation-row]")?.dataset.quotationRow;
        const row = b.flatRows.find(item => item.id === id);
        if (row?.kind !== "line") return;
        event.preventDefault(); event.stopPropagation();
        const direction = event.key === "ArrowUp" ? -1 : 1;
        const peers = b.flatRows.filter(item => item.kind === "line" && !item.line.included_for_line_id);
        const nextPosition = peers.indexOf(row) + direction;
        if (!peers[nextPosition]) return;
        b.moveLine(row.id, direction);
        setOrderMessage(`${row.line.name} moved to position ${nextPosition + 1} of ${peers.length}.`);
        requestAnimationFrame(() => handle?.focus({ preventScroll: true }));
      }}
    >
      {rows.map(item => <div key={item.id} data-quotation-row={item.id} data-dragging={!!drag.current?.movingIds.has(item.id) || undefined}
        style={{ position: "relative", zIndex: !!drag.current?.movingIds.has(item.id) ? 2 : 0, ...(!!drag.current?.movingIds.has(item.id) ? { cursor: "grabbing", boxShadow: "0 10px 24px rgba(0,0,0,0.18)", borderRadius: radius.md, pointerEvents: "none" } : {}) }}>
        {item.kind === "room-header"
          ? <RoomHeaderRow {...item} />
          : <LineRow line={item.line} drag={() => {}} isActive={!!drag.current?.movingIds.has(item.id)} catDiscs={b.s.categoryDiscounts} projDisc={b.s.projectDiscount} roomDiscs={b.s.roomDiscounts} compact={compact} />}
      </div>)}
      {rows.length === 1 ? <EmptyRoom compact={compact} /> : null}
      <span role="status" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}>{orderMessage}</span>
    </div>
  </ScrollView>;
}
