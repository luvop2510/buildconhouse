import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { Platform, View } from 'react-native';

// The topmost portal remains interactive even if an underlying dialog previously
// isolated its already-mounted portal. Recompute isolation when the stack changes.
const portals: HTMLElement[] = [];
const panels = new Map<HTMLElement, HTMLElement>();
const isolated = new Map<HTMLElement, { inert: boolean; hidden: string | null }>();
// Unlike the opening active element, an explicit trigger can be replaced by
// responsive rendering while the overlay is mounted.
function liveTrigger(ref?: RefObject<View | null>) {
  return ref?.current as unknown as HTMLElement | null;
}
function isolate(element: HTMLElement) {
  if (isolated.has(element)) return;
  isolated.set(element, { inert: element.inert, hidden: element.getAttribute('aria-hidden') });
  element.inert = true; element.setAttribute('aria-hidden', 'true');
}
function restore(element: HTMLElement) {
  const previous = isolated.get(element);
  if (!previous) return;
  element.inert = previous.inert;
  if (previous.hidden === null) element.removeAttribute('aria-hidden'); else element.setAttribute('aria-hidden', previous.hidden);
  isolated.delete(element);
}

function syncIsolation() {
  const top = portals[portals.length - 1];
  if (!top) { Array.from(isolated.keys()).forEach(restore); return; }
  restore(top);
  for (const sibling of Array.from(document.body.children)) {
    if (sibling instanceof HTMLElement && sibling !== top && !["SCRIPT", "STYLE", "LINK"].includes(sibling.tagName)) isolate(sibling);
  }
}

/** Focus containment, background isolation and restoration for every web overlay. */
export function useOverlayFocus(open: boolean, onClose: () => void, dismissable = true, returnFocusRef?: RefObject<View | null>) {
  const ref = useRef<View>(null);
  const closeRef = useRef(onClose);
  const dismissableRef = useRef(dismissable);
  // Event listeners belong to the committed overlay. An interrupted render
  // must not replace its close callback or dismissal policy.
  useLayoutEffect(() => {
    closeRef.current = onClose;
    dismissableRef.current = dismissable;
  }, [onClose, dismissable]);
  useEffect(() => {
    if (!open || Platform.OS !== 'web') return;
    // Explicit triggers survive an autoFocus child moving focus before this
    // effect. Other overlays retain their current active-element behavior.
    const previous = (returnFocusRef?.current || document.activeElement) as HTMLElement | null;
    let panel: HTMLElement | null = null;
    let activePortal: HTMLElement | null = null;
    const focusables = () => Array.from(panel?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]',
    ) || []).filter(el => el.getClientRects().length > 0 && el.getAttribute('aria-disabled') !== 'true');
    const timer = setTimeout(() => {
      panel = ref.current as unknown as HTMLElement;
      let portal = panel;
      while (portal?.parentElement && portal.parentElement !== document.body) portal = portal.parentElement;
      if (portal?.parentElement === document.body) {
        activePortal = portal;
        portals.push(portal);
        panels.set(portal, panel);
        syncIsolation();
      }
      (focusables()[0] || panel)?.focus();
    }, 0);
    const handleKey = (event: KeyboardEvent) => {
      // Only the topmost modal should receive keyboard events.
      if (!panel?.contains(document.activeElement)) return;

      if (event.key === 'Tab') {
        const elements = focusables();
        const first = elements[0]; const last = elements[elements.length - 1];
        if (!first) { event.preventDefault(); panel.focus(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && panel?.contains(document.activeElement)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (dismissableRef.current) closeRef.current();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    document.addEventListener('keyup', handleEscape, true);
    return () => {
      clearTimeout(timer); document.removeEventListener('keydown', handleKey, true);
      document.removeEventListener('keyup', handleEscape, true);
      if (activePortal) {
        const index = portals.lastIndexOf(activePortal);
        if (index >= 0) portals.splice(index, 1);
        panels.delete(activePortal);
        syncIsolation();
      }
      const restoredPortal = portals[portals.length - 1];
      // React Native Web also restores focus while unmounting its Modal.
      // Run after that cleanup so it cannot leave focus on the backdrop of
      // the underlying dialog, where Escape and Tab cannot reach our panel.
      let closingFrames = 0;
      const restoreFocus = () => {
        if (portals[portals.length - 1] !== restoredPortal) return;
        // RNW's portal survives its first dismissal frame. Focusing its
        // trigger while that portal still traps focus immediately sends
        // focus back into the closing form. Wait for its actual removal.
        if (panel?.isConnected && closingFrames++ < 60) {
          requestAnimationFrame(restoreFocus);
          return;
        }
        const restoredPanel = restoredPortal ? panels.get(restoredPortal) : undefined;
        // A responsive header may replace the trigger while its sheet is open.
        // Read the live explicit ref after dismissal, not only the opening node.
        const explicit = liveTrigger(returnFocusRef);
        const target = explicit?.isConnected ? explicit : previous;
        // Closing portals can outlive dismissal by several frames. A user may
        // already be editing the next field when restoration finally runs.
        // Keep that live destination, including a field in the underlying dialog.
        const focused = document.activeElement as HTMLElement | null;
        if (focused?.isConnected && focused !== document.body && !panel?.contains(focused)
          && (!restoredPanel || restoredPanel.contains(focused))) return;
        if (target?.isConnected && (!restoredPanel || restoredPanel.contains(target))) target.focus();
        else if (restoredPanel?.isConnected) {
          const target = restoredPanel.querySelector<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]');
          (target || restoredPanel).focus();
        }
      };
      requestAnimationFrame(restoreFocus);
    };
  }, [open, returnFocusRef]);
  return ref;
}
