import { useEffect } from 'react';
import { Platform } from 'react-native';

/** Mobile browsers can keep the layout viewport tall when their keyboard opens.
 * Size the app and modal portals to the visible area, without rerendering pages.
 */
export function useKeyboardViewport() {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    const style = document.documentElement.style;
    let frame = 0;
    let revealFrame = 0;
    let revealPending = false;
    let lastHeight = -1;
    let lastTop = -1;
    const reveal = () => {
      revealFrame = 0;
      const input = document.activeElement;
      if (Math.abs(viewport.scale - 1) > .01) return;
      if (!(input instanceof HTMLElement) || !input.matches('input,textarea,[contenteditable="true"]')) return;
      // Browser focus scrolling happens before the keyboard has finished
      // resizing. Repeat only when a visible-area change clips the input.
      const clips: { element: HTMLElement; scrollable: boolean }[] = [];
      for (let parent = input.parentElement; parent; parent = parent.parentElement) {
        const overflow = window.getComputedStyle(parent).overflowY;
        if (/auto|scroll|hidden|clip/.test(overflow)) clips.push({ element: parent, scrollable: /auto|scroll/.test(overflow) });
      }
      // Scroll the form, never the document: scrollIntoView can pan Safari's
      // entire fixed application. A second pass handles a previously clipped inner panel.
      for (let pass = 0; pass < 2; pass++) for (const { element: parent, scrollable } of clips) {
        if (parent === document.body || parent === document.documentElement || parent.id === 'root'
          || !scrollable
          || parent.scrollHeight <= parent.clientHeight) continue;
        let top = viewport.offsetTop + 8;
        let bottom = viewport.offsetTop + viewport.height - 8;
        for (const { element: clip } of clips) {
          const bounds = clip.getBoundingClientRect();
          top = Math.max(top, bounds.top + clip.clientTop + 8);
          bottom = Math.min(bottom, bounds.top + clip.clientTop + clip.clientHeight - 8);
        }
        if (bottom <= top) continue;
        const box = input.getBoundingClientRect();
        const delta = box.height > bottom - top || box.top < top ? box.top - top : Math.max(0, box.bottom - bottom);
        // Most keystrokes need no correction; avoid repeated layout reads and scroll writes.
        if (delta === 0) return;
        const change = Math.max(-parent.scrollTop, Math.min(delta, parent.scrollHeight - parent.clientHeight - parent.scrollTop));
        if (change !== 0) parent.scrollTop += change;
      }
    };
    const update = () => {
      frame = 0;
      // Pinch zoom must retain ordinary browser panning; it is not a keyboard.
      if (Math.abs(viewport.scale - 1) > .01) return;
      const resized = viewport.height !== lastHeight;
      if (resized) style.setProperty('--forge-visible-height', `${viewport.height}px`);
      if (viewport.offsetTop !== lastTop) style.setProperty('--forge-visible-top', `${viewport.offsetTop}px`);
      lastHeight = viewport.height;
      lastTop = viewport.offsetTop;
      if (revealPending || resized) {
        cancelAnimationFrame(revealFrame);
        revealFrame = requestAnimationFrame(reveal);
      }
      revealPending = false;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    // Browser focus scrolling also emits viewport scroll events. Correcting
    // focus on those events fights the user's scroll and can bounce the form.
    const onFocus = () => { revealPending = true; schedule(); };
    schedule();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('input', onFocus);
    return () => {
      cancelAnimationFrame(frame); cancelAnimationFrame(revealFrame);
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('input', onFocus);
      style.removeProperty('--forge-visible-height'); style.removeProperty('--forge-visible-top');
    };
  }, []);
}
