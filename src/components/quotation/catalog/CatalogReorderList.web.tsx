import Feather from "@expo/vector-icons/Feather";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ScrollView } from "react-native";

import { useReducedMotion } from "@/src/hooks/use-reduced-motion";
import { catalogItemKey } from "@/src/services/catalogService";
import { colors, radius, spacing } from "@/src/theme/tokens";

import { moveCatalogProduct, type CatalogReorderListProps } from "./CatalogReorderList.shared";

type Point = { x: number; y: number };
type Slot = Point & { row: HTMLElement; card: HTMLButtonElement; width: number; height: number };
type Drag = {
  from: number;
  target: number;
  slots: Slot[];
  scroll: Element | null;
  source: { id: number; kind: "pointer" | "touch" };
  start: Point;
  point: Point;
  grab: Point;
  active: boolean;
  frame: number;
  hold?: number;
};

const HOLD_MS = 260;
const TOUCH_SLOP = 9;
const DRAG_DISTANCE = 5;
const GAP = spacing.s8;
const CARD_HEIGHT = 142;
const visuallyHidden: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" };

function scrollParent(element: HTMLElement) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) {
      return parent;
    }
  }
  return document.scrollingElement;
}

function scrollNearEdge(drag: Drag, elapsed: number) {
  if (!drag.scroll || !elapsed || drag.point === drag.start) return;
  const viewport = window.visualViewport;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
  const bounds = drag.scroll === document.scrollingElement
    ? { top: viewportTop, bottom: viewportBottom }
    : drag.scroll.getBoundingClientRect();
  const top = Math.max(viewportTop, bounds.top);
  const bottom = Math.min(viewportBottom, bounds.bottom);
  const edge = Math.min(64, (bottom - top) / 4);
  if (edge <= 0) return;
  const y = drag.point.y;
  const distance = y < top + edge ? y - top - edge : Math.max(0, y - bottom + edge);
  if (distance) drag.scroll.scrollTop += Math.max(-24, Math.min(24, distance / 2)) * elapsed / (1000 / 60);
}

function translation(x: number, y: number) {
  return `translate3d(${x}px, ${y}px, 0)`;
}

function displacedIndex(index: number, from: number, to: number) {
  if (from < index && index <= to) return index - 1;
  if (to <= index && index < from) return index + 1;
  return index;
}

const Card = memo(function Card({ product, renderCard }: {
  product: CatalogReorderListProps["products"][number];
  renderCard: CatalogReorderListProps["renderCard"];
}) {
  return renderCard(product);
});

export function CatalogReorderList({ products, columns, onReorder, renderCard, disabled }: CatalogReorderListProps) {
  const grid = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const instructions = useId();
  const reducedMotion = useReducedMotion();

  const release = useCallback(() => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    cancelAnimationFrame(current.frame);
    window.clearTimeout(current.hold);
    for (let i = Math.min(current.from, current.target); i <= Math.max(current.from, current.target); i++) {
      current.slots[i].card.style.transform = "";
    }
    const { card, row } = current.slots[current.from];
    delete row.dataset.catalogDragging;
    row.style.zIndex = "";
    card.style.removeProperty("--drag-border");
    card.style.removeProperty("--drag-shadow");
    card.style.removeProperty("--drag-transition");
    card.style.removeProperty("--drag-cursor");
    delete current.slots[current.target].row.dataset.catalogDropTarget;
    if (marker.current) marker.current.style.display = "none";
    if (current.source.kind === "pointer" && card.hasPointerCapture(current.source.id)) {
      card.releasePointerCapture(current.source.id);
    }
  }, []);

  useLayoutEffect(release, [release, products, columns, disabled]);

  const commit = useCallback((from: number, to: number) => {
    if (disabled) return;
    const next = moveCatalogProduct(products, from, to);
    if (next === products) return;
    onReorder(next);
    setAnnouncement(`${next[to].name} moved to position ${to + 1} of ${next.length}.`);
  }, [disabled, products, onReorder]);

  const update = useCallback((current: Drag, elapsed: number) => {
    if (!grid.current) return;
    scrollNearEdge(current, elapsed);
    const rect = grid.current.getBoundingClientRect();
    const source = current.slots[current.from];
    const first = current.slots[0];
    const x = current.point.x - current.grab.x - rect.left;
    const y = current.point.y - current.grab.y - rect.top;
    source.card.style.transform = `${translation(x - source.x, y - source.y)} scale(1.025)`;
    const row = Math.max(0, Math.round((y - first.y) / (first.height + GAP)));
    const col = Math.max(0, Math.min(columns - 1, Math.round((x - first.x) / (first.width + GAP))));
    const target = Math.min(current.slots.length - 1, row * columns + col);
    if (target === current.target) return;

    // Keep slot geometry fixed, moving only the cards that changed position
    // since the last pointer frame. This also works while the list scrolls.
    delete current.slots[current.target].row.dataset.catalogDropTarget;
    for (let i = Math.min(current.target, target); i <= Math.max(current.target, target); i++) {
      if (i === current.from) continue;
      const slot = current.slots[i];
      const destination = current.slots[displacedIndex(i, current.from, target)];
      slot.card.style.transform = slot === destination ? "" : translation(destination.x - slot.x, destination.y - slot.y);
    }
    current.target = target;
    if (marker.current) {
      const slot = current.slots[target];
      const moved = target !== current.from;
      if (moved) slot.row.dataset.catalogDropTarget = target < current.from ? "before" : "after";
      marker.current.style.display = moved ? "block" : "none";
      marker.current.style.transform = translation(slot.x, slot.y);
      marker.current.style.width = `${slot.width}px`;
      marker.current.style.height = `${slot.height}px`;
    }
  }, [columns]);

  const lift = useCallback((current: Drag) => {
    if (drag.current !== current || current.active) return;
    current.active = true;
    const { row, card } = current.slots[current.from];
    row.dataset.catalogDragging = "true";
    row.style.zIndex = "3";
    card.style.setProperty("--drag-cursor", "grabbing");
    card.style.setProperty("--drag-border", colors.brand);
    card.style.setProperty("--drag-shadow", "0 8px 22px rgba(0, 0, 0, 0.16)");
    card.style.setProperty("--drag-transition", "none");
    let lastFrame = performance.now();
    const tick = (now: number) => {
      if (drag.current !== current) return;
      update(current, Math.min(64, Math.max(0, now - lastFrame)));
      lastFrame = now;
      current.frame = requestAnimationFrame(tick);
    };
    current.frame = requestAnimationFrame(tick);
  }, [update]);

  const start = useCallback((card: HTMLButtonElement, point: Point, source: Drag["source"]) => {
    if (disabled || drag.current || !grid.current) return;
    const from = Number(card.dataset.catalogDragIndex);
    const slots = Array.from(grid.current.querySelectorAll<HTMLElement>("[data-catalog-reorder-row]"), row => ({
      row, card: row.firstElementChild as HTMLButtonElement, x: row.offsetLeft, y: row.offsetTop,
      width: row.offsetWidth, height: row.offsetHeight,
    }));
    if (!slots[from]) return;
    const { left, top } = slots[from].row.getBoundingClientRect();
    const current: Drag = {
      from, target: from, slots, source, scroll: scrollParent(slots[from].row), start: point, point,
      grab: { x: point.x - left, y: point.y - top }, active: false, frame: 0,
    };
    drag.current = current;
    if (source.kind === "touch") current.hold = window.setTimeout(() => lift(current), HOLD_MS);
    else {
      card.focus({ preventScroll: true });
      card.setPointerCapture(source.id);
    }
  }, [disabled, lift]);

  const move = useCallback((current: Drag, point: Point) => {
    current.point = point;
    if (current.active) return;
    const distance = Math.hypot(point.x - current.start.x, point.y - current.start.y);
    if (current.source.kind === "touch" && distance > TOUCH_SLOP) release();
    if (current.source.kind === "pointer" && distance >= DRAG_DISTANCE) lift(current);
  }, [lift, release]);

  const finish = useCallback((current: Drag, point: Point) => {
    current.point = point;
    if (current.active) update(current, 0);
    release();
    if (current.active) commit(current.from, current.target);
  }, [commit, release, update]);

  useEffect(() => {
    const element = grid.current;
    if (!element) return;
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        release();
        return;
      }
      const touch = event.changedTouches[0];
      const card = (event.target as Element).closest<HTMLButtonElement>("[data-catalog-drag-index]");
      if (touch && card) start(card, { x: touch.clientX, y: touch.clientY }, { id: touch.identifier, kind: "touch" });
    };
    const changedTouch = (event: TouchEvent, handle: (current: Drag, touch: Touch) => void) => {
      const current = drag.current;
      if (!current || current.source.kind !== "touch") return;
      const touch = Array.from(event.changedTouches).find(candidate => candidate.identifier === current.source.id);
      if (touch) handle(current, touch);
    };
    const touchMove = (event: TouchEvent) => changedTouch(event, (current, touch) => {
      // A swipe before the hold is native scrolling. A held drag owns the
      // gesture, so Safari and Chromium do not scroll underneath the card.
      if (current.active && event.cancelable) event.preventDefault();
      move(current, { x: touch.clientX, y: touch.clientY });
    });
    const touchEnd = (event: TouchEvent) => changedTouch(event, (current, touch) => {
      if (current.active && event.cancelable) event.preventDefault();
      finish(current, { x: touch.clientX, y: touch.clientY });
    });
    const touchCancel = (event: TouchEvent) => changedTouch(event, release);
    element.addEventListener("touchstart", touchStart, { passive: true });
    element.addEventListener("touchmove", touchMove, { passive: false });
    element.addEventListener("touchend", touchEnd, { passive: false });
    element.addEventListener("touchcancel", touchCancel);
    window.addEventListener("blur", release);
    window.addEventListener("resize", release);
    return () => {
      release();
      element.removeEventListener("touchstart", touchStart);
      element.removeEventListener("touchmove", touchMove);
      element.removeEventListener("touchend", touchEnd);
      element.removeEventListener("touchcancel", touchCancel);
      window.removeEventListener("blur", release);
      window.removeEventListener("resize", release);
    };
  }, [finish, move, release, start]);

  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} keyboardShouldPersistTaps="handled" testID="catalog-reorder-list">
      <div ref={grid} role="list" aria-label="Catalog product order" style={{ position: "relative", display: "grid",
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: CARD_HEIGHT, gap: GAP, padding: spacing.s12 }}>
        {products.map((product, index) => (
          <div key={catalogItemKey(product)} role="listitem" data-catalog-reorder-row
            data-testid={`catalog-reorder-row-${product.id}`} style={{ position: "relative" }}>
            <button type="button" aria-label={`Reorder ${product.name}`} aria-describedby={instructions}
              disabled={disabled} data-testid={`catalog-drag-${product.id}`} data-catalog-drag-index={index}
              style={{ display: "block", width: "100%", height: "100%", padding: spacing.s8, textAlign: "start",
                background: colors.surfaceSecondary, border: `1px solid var(--drag-border, ${colors.border})`, borderRadius: radius.md,
                cursor: disabled ? "default" : "var(--drag-cursor, grab)", touchAction: "pan-y pinch-zoom", userSelect: "none",
                WebkitUserSelect: "none", WebkitTouchCallout: "none", contentVisibility: "auto",
                boxShadow: "var(--drag-shadow, none)", transition: reducedMotion ? undefined : "var(--drag-transition, transform 150ms ease-out)" }}
              onContextMenu={event => event.preventDefault()}
              onDragStart={event => event.preventDefault()}
              onPointerDown={event => {
                if (event.pointerType === "touch" || !event.isPrimary || event.button !== 0) return;
                start(event.currentTarget, { x: event.clientX, y: event.clientY }, { id: event.pointerId, kind: "pointer" });
              }}
              onPointerMove={event => {
                const current = drag.current;
                if (current?.source.kind === "pointer" && current.source.id === event.pointerId) {
                  move(current, { x: event.clientX, y: event.clientY });
                }
              }}
              onPointerUp={event => {
                const current = drag.current;
                if (current?.source.kind === "pointer" && current.source.id === event.pointerId) {
                  finish(current, { x: event.clientX, y: event.clientY });
                }
              }}
              onPointerCancel={event => { if (drag.current?.source.kind === "pointer" && drag.current.source.id === event.pointerId) release(); }}
              onLostPointerCapture={event => { if (drag.current?.source.kind === "pointer" && drag.current.source.id === event.pointerId) release(); }}
              onKeyDown={event => {
                if (drag.current && event.key === "Escape") {
                  event.stopPropagation();
                  release();
                  return;
                }
                if (drag.current || !["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"].includes(event.key)) return;
                event.preventDefault();
                event.stopPropagation();
                const card = event.currentTarget;
                commit(index, index + (event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1));
                requestAnimationFrame(() => {
                  if (!card.isConnected) return;
                  card.focus({ preventScroll: true });
                  card.scrollIntoView({ block: "nearest" });
                });
              }}>
              <Card product={product} renderCard={renderCard} />
              <span aria-hidden="true" style={{ position: "absolute", right: spacing.s8, top: spacing.s8 }}>
                <Feather name="menu" color={colors.onSurfaceSecondary} size={13} />
              </span>
            </button>
          </div>
        ))}
        <div ref={marker} aria-hidden="true" style={{ position: "absolute", top: 0, left: 0, display: "none",
          boxSizing: "border-box", border: `2px dashed ${colors.brand}`, borderRadius: radius.md, zIndex: 2, pointerEvents: "none" }} />
      </div>
      <span id={instructions} style={visuallyHidden}>Drag the card. On touch screens, hold first. Use the arrow keys to move by one position.</span>
      <span role="status" style={visuallyHidden}>{announcement}</span>
    </ScrollView>
  );
}
