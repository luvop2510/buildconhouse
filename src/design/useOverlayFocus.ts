import { useEffect, useLayoutEffect, useRef } from 'react';
import { Platform, View } from 'react-native';

// The topmost portal remains interactive even if an underlying dialog previously
// isolated its already-mounted portal. Recompute isolation when the stack changes.
const portals: HTMLElement[] = [];
const isolated = new Map<HTMLElement, { inert: boolean; hidden: string | null }>();
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
export function useOverlayFocus(open: boolean, onClose: () => void, dismissable = true) {
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
    const previous = document.activeElement as HTMLElement | null;
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
        syncIsolation();
      }
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);
  return ref;
}
