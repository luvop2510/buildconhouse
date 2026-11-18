import Feather from "@expo/vector-icons/Feather";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { ScrollView } from "react-native";

import { catalogItemKey } from "@/src/services/catalogService";
import { colors, radius, spacing } from "@/src/theme/tokens";

import { moveCatalogProduct, type CatalogReorderListProps } from "./CatalogReorderList.shared";

type DropMarker = { rowKey: string; edge: "before" | "after"; top: number };
type Drag = {
  from: number;
  target: number;
  row: HTMLElement;
  card: HTMLElement;
  handle: HTMLButtonElement;
  peers: HTMLElement[];
  scroll: Element | null;
  pointerId: number;
  startY: number;
  y: number;
  grabOffset: number;
  active: boolean;
  frame: number;
};

const hiddenText: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" };

function scrollParent(element: HTMLElement) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) {
      return parent;
    }
  }
  return document.scrollingElement;
}

function scrollNearEdge(drag: Drag, elapsed: number) {
  const { scroll, y } = drag;
  if (!scroll) return;
  const viewport = window.visualViewport;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
  const bounds = scroll === document.scrollingElement
    ? { top: viewportTop, bottom: viewportBottom }
    : scroll.getBoundingClientRect();
  const top = Math.max(viewportTop, bounds.top);
  const bottom = Math.min(viewportBottom, bounds.bottom);
  const edge = Math.min(64, (bottom - top) / 4);
  if (edge <= 0) return;
  const distance = y < top + edge ? y - top - edge : Math.max(0, y - bottom + edge);
  if (distance) scroll.scrollTop += Math.max(-24, Math.min(24, distance / 2)) * elapsed / (1000 / 60);
}

function insertionIndex(peers: HTMLElement[], centerY: number) {
  // Peers never move during the drag. Search their vertically ordered midpoints.
  let start = 0;
  let end = peers.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    const rect = peers[middle].getBoundingClientRect();
    if (centerY <= rect.top + rect.height / 2) end = middle;
    else start = middle + 1;
  }
  return start;
}

export function CatalogReorderList({ products, onReorder, renderCard, disabled }: CatalogReorderListProps) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [marker, setMarker] = useState<DropMarker | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const instructions = useId();

  const release = useCallback(() => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    cancelAnimationFrame(current.frame);
    current.card.style.transform = "";
    if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
  }, []);

  const cancel = useCallback(() => {
    release();
    setDragging(null);
    setMarker(null);
  }, [release]);

  useLayoutEffect(cancel, [cancel, products, disabled]);
  useEffect(() => {
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      release();
    };
  }, [cancel, release]);

  const commit = (from: number, to: number) => {
    if (disabled) return;
    const next = moveCatalogProduct(products, from, to);
    if (next === products) return;
    onReorder(next);
    setAnnouncement(`${next[to].name} moved to position ${to + 1} of ${next.length}.`);
  };

  const update = (current: Drag, elapsed: number) => {
    if (!current.active && Math.abs(current.y - current.startY) < 5) return;
    if (!current.active) setDragging(current.row.dataset.catalogReorderRow!);
    current.active = true;
    scrollNearEdge(current, elapsed);
    const rowRect = current.row.getBoundingClientRect();
    const top = current.y - current.grabOffset;
    current.card.style.transform = `translateY(${top - rowRect.top}px)`;
    const target = insertionIndex(current.peers, top + rowRect.height / 2);
    if (target === current.target) return;
    current.target = target;
    const before = current.peers[target];
    const adjacent = before ?? current.peers.at(-1);
    setMarker(target === current.from || !adjacent ? null : {
      rowKey: adjacent.dataset.catalogReorderRow!,
      edge: before ? "before" : "after",
      top: adjacent.offsetTop + (before ? -5 : adjacent.offsetHeight + 2),
    });
  };

  const start = (event: PointerEvent<HTMLButtonElement>, from: number) => {
    if (disabled || drag.current || !event.isPrimary || event.button !== 0) return;
    const handle = event.currentTarget;
    const row = handle.closest<HTMLElement>("[data-catalog-reorder-row]");
    const card = handle.parentElement;
    if (!row || !card) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    const peers = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-catalog-reorder-row]") ?? [])
      .filter(element => element !== row);
    const current: Drag = {
      from, target: from, row, card, handle, peers, scroll: scrollParent(row),
      pointerId: event.pointerId, startY: event.clientY, y: event.clientY,
      grabOffset: event.clientY - row.getBoundingClientRect().top, active: false, frame: 0,
    };
    drag.current = current;
    let lastFrame = performance.now();
    const tick = (now: number) => {
      if (drag.current !== current) return;
      update(current, Math.min(64, Math.max(0, now - lastFrame)));
      lastFrame = now;
      current.frame = requestAnimationFrame(tick);
    };
    current.frame = requestAnimationFrame(tick);
  };

  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} keyboardShouldPersistTaps="handled" testID="catalog-reorder-list">
      <div ref={root} role="list" aria-label="Catalog product order" style={{ position: "relative", display: "flex", flexDirection: "column", gap: spacing.s8, padding: spacing.s12 }}>
        {products.map((product, index) => {
          const key = catalogItemKey(product);
          const isDragging = dragging === key;
          const edge = marker?.rowKey === key ? marker.edge : undefined;
          return (
            <div key={key} role="listitem" data-catalog-reorder-row={key} data-catalog-drop-target={edge}
              data-testid={`catalog-reorder-row-${product.id}`}
              style={{ position: "relative", zIndex: isDragging ? 2 : 0, borderRadius: radius.md, background: isDragging ? colors.brandTint : undefined }}>
              <div style={{
                display: "flex", alignItems: "center", gap: spacing.s8, padding: spacing.s4,
                background: colors.surfaceSecondary, border: `1px solid ${isDragging ? colors.brand : colors.border}`,
                borderRadius: radius.md, boxShadow: isDragging ? "0 8px 22px rgba(0, 0, 0, 0.16)" : undefined,
              }}>
                <button type="button" aria-label={`Reorder ${product.name}`} aria-describedby={instructions}
                  disabled={disabled} data-testid={`catalog-drag-${product.id}`}
                  style={{ width: 44, height: 44, display: "grid", placeItems: "center", flexShrink: 0,
                    border: 0, borderRadius: radius.sm, background: colors.surfaceTertiary,
                    cursor: disabled ? "default" : isDragging ? "grabbing" : "grab",
                    touchAction: "none", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" }}
                  onPointerDown={event => start(event, index)}
                  onPointerMove={event => {
                    const current = drag.current;
                    if (current?.pointerId === event.pointerId) current.y = event.clientY;
                  }}
                  onPointerUp={event => {
                    const current = drag.current;
                    if (current?.pointerId !== event.pointerId) return;
                    current.y = event.clientY;
                    update(current, 0);
                    cancel();
                    if (current.active) commit(current.from, current.target);
                  }}
                  onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) cancel(); }}
                  onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) cancel(); }}
                  onKeyDown={event => {
                    if (drag.current && event.key === "Escape") {
                      event.stopPropagation();
                      cancel();
                      return;
                    }
                    if (drag.current || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const handle = event.currentTarget;
                    commit(index, index + (event.key === "ArrowUp" ? -1 : 1));
                    requestAnimationFrame(() => {
                      if (!handle.isConnected) return;
                      handle.focus({ preventScroll: true });
                      handle.scrollIntoView({ block: "nearest" });
                    });
                  }}>
                  <Feather name="menu" color={colors.onSurfaceSecondary} size={17} />
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>{renderCard(product)}</div>
              </div>
            </div>
          );
        })}
        {marker ? <div aria-hidden="true" style={{ position: "absolute", top: marker.top, left: spacing.s12, right: spacing.s12,
          height: 3, backgroundColor: colors.brand, borderRadius: radius.sm, zIndex: 3, pointerEvents: "none" }} /> : null}
      </div>
      <span id={instructions} style={hiddenText}>Drag this handle, or press the Up or Down arrow key to move the product.</span>
      <span role="status" style={hiddenText}>{announcement}</span>
    </ScrollView>
  );
}
