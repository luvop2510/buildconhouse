import { useEffect } from 'react';
import { Platform } from 'react-native';

/** Safari keeps the layout viewport tall when its software keyboard opens.
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
      const box = input.getBoundingClientRect();
      let top = viewport.offsetTop + 8;
      let bottom = viewport.offsetTop + viewport.height - 8;
      // Reserved phone chrome and nested panels can clip inside the visual viewport.
      for (let parent = input.parentElement; parent; parent = parent.parentElement) {
        if (!/auto|scroll|hidden|clip/.test(window.getComputedStyle(parent).overflowY)) continue;
        const bounds = parent.getBoundingClientRect();
        top = Math.max(top, bounds.top + parent.clientTop + 8);
        bottom = Math.min(bottom, bounds.top + parent.clientTop + parent.clientHeight - 8);
      }
      if (box.top < top || box.bottom > bottom) input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
