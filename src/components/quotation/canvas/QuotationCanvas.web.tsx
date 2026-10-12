// Pointer-based ordering works with mouse, pen and touch without native gestures.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";
import Feather from "@expo/vector-icons/Feather";

import { EmptyState } from "@/src/components/ui";
import { font, radius, spacing } from "@/src/theme/tokens";
import { color as ds } from "@/src/design/tokens";

import { useBuilder } from "../context/BuilderContext";
import { moveQuotationRows } from "../helpers/reorder";
import type { BuilderRow } from "../helpers/types";
import { LineRow } from "./LineRow";
import { RoomHeaderRow } from "./RoomHeaderRow";

type Drag = { id: string; pointerId: number; y: number; grabOffset: number; capture: HTMLElement; scroll: HTMLElement | null; changed: boolean };

export function QuotationCanvas({ compact = false }: { compact?: boolean }) {
  const b = useBuilder();
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<BuilderRow[] | null>(null);
  const previewRef = useRef<BuilderRow[] | null>(null);
  const previousPositions = useRef(new Map<string, number>());
  const animations = useRef(new Map<string, Animation>());
  const commitRef = useRef(b.onLinesDragEnd);
  commitRef.current = b.onLinesDragEnd;
  const rows = preview || b.flatRows;
  const getRows = () => Array.from(root.current?.querySelectorAll<HTMLElement>("[data-quotation-row]") || []);

  const finish = (cancel = false) => {
    const current = drag.current;
    if (!current) return;
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
      if (current && id !== current.id && previous !== undefined && previous !== element.offsetTop && !reducedMotion) {
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
    const tick = () => {
      const current = drag.current;
      const container = root.current;
      if (!current || !container) return;
      const elements = getRows();
      const active = elements.find(element => element.dataset.quotationRow === current.id);
      if (!active) { finish(true); return; }
      if (current.scroll) {
        const rect = current.scroll.getBoundingClientRect();
        const upper = Math.max(0, rect.top);
        const lower = Math.min(window.innerHeight, rect.bottom);
        const edge = 64;
        const distance = current.y < upper + edge ? -Math.min(18, (upper + edge - current.y) / 4)
          : current.y > lower - edge ? Math.min(18, (current.y - lower + edge) / 4) : 0;
        if (distance) current.scroll.scrollTop += distance;
      }
      const top = container.getBoundingClientRect().top;
      const candidates = (previewRef.current || []).filter(row => row.id !== current.id && !(row.kind === "line" && row.line.included_for_line_id === current.id));
      let target = candidates.length;
      for (let i = 0; i < candidates.length; i += 1) {
        const element = elements.find(element => element.dataset.quotationRow === candidates[i].id);
        if (element && current.y < top + element.offsetTop + element.offsetHeight / 2) { target = i; break; }
      }
      const next = moveQuotationRows(previewRef.current || [], current.id, target);
      if (next !== previewRef.current) {
        previousPositions.current = new Map(elements.map(element => [element.dataset.quotationRow!, element.offsetTop]));
        previewRef.current = next;
        current.changed = true;
        setPreview(next);
      }
      active.style.transform = `translateY(${current.y - current.grabOffset - top - active.offsetTop}px) scale(1.01)`;
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
    if (!row || row.kind !== "line" || row.line.included_for_line_id || !rowElement) return;
    event.preventDefault();
    event.stopPropagation();
    let scroll = root.current?.parentElement || null;
    while (scroll && !/(auto|scroll)/.test(getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      id: row.id, pointerId: event.pointerId, y: event.clientY,
      grabOffset: event.clientY - rowElement.getBoundingClientRect().top,
      capture: event.currentTarget, scroll, changed: false,
    };
    previewRef.current = b.flatRows;
    previousPositions.current = new Map(getRows().map(element => [element.dataset.quotationRow!, element.offsetTop]));
    setPreview(b.flatRows);
    setDraggingId(row.id);
  };

  if (!b.s.lines.length) {
    return <View style={{ flex: 1, justifyContent: "center" }}><EmptyState icon="file-plus" title="Add your first product" subtitle={compact ? "Tap Browse catalog to search and add products. Everything totals live." : "Search on the left and tap to add. Everything totals live."} />{compact ? <Pressable testID="empty-browse-catalog" onPress={() => b.setPickerSheetOpen(true)} style={styles.browseBtn}><Feather name="search" size={15} color={ds.canvas} /><Text style={styles.browseBtnText}>Browse catalog</Text></Pressable> : null}</View>;
  }
  return <ScrollView style={{ flex: 1, minHeight: 0 }} keyboardShouldPersistTaps="handled" testID="receipt-list">
    <div ref={root} style={{ position: "relative", padding: spacing.md, paddingBottom: 32, display: "flex", flexDirection: "column", gap: 6 }}
      onPointerDown={start}
      onPointerMove={event => { if (drag.current?.pointerId === event.pointerId) { event.preventDefault(); drag.current.y = event.clientY; } }}
      onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) finish(); }}
      onPointerCancel={() => finish(true)}
      onLostPointerCapture={() => finish(true)}
    >
      {rows.map(item => <div key={item.id} data-quotation-row={item.id} data-dragging={draggingId === item.id || undefined}
        style={{ position: "relative", zIndex: draggingId === item.id ? 2 : 0, ...(draggingId === item.id ? { cursor: "grabbing", boxShadow: "0 10px 24px rgba(0,0,0,0.18)", borderRadius: radius.md, pointerEvents: "none" } : {}) }}>
        {item.kind === "room-header"
          ? <RoomHeaderRow roomName={item.roomName} itemCount={item.itemCount} subtotal={item.subtotal} collapsed={item.collapsed} drag={() => {}} isActive={false} roomDiscount={item.roomDiscount} />
          : <LineRow line={item.line} drag={() => {}} isActive={draggingId === item.id} catDiscs={b.s.categoryDiscounts} projDisc={b.s.projectDiscount} roomDiscs={b.s.roomDiscounts} compact={compact} />}
      </div>)}
    </div>
  </ScrollView>;
}

const styles = StyleSheet.create({
  browseBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: spacing.lg, marginHorizontal: spacing.xl, backgroundColor: ds.brass, paddingVertical: 12, borderRadius: radius.md },
  browseBtnText: { color: ds.canvas, fontSize: 14, fontFamily: font.semibold, fontWeight: "600" },
});
