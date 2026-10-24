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
    const reveal = () => {
      revealFrame = 0;
      const input = document.activeElement;
      if (!(input instanceof HTMLElement) || !input.matches('input,textarea,[contenteditable="true"]')) return;
      // Browser focus scrolling happens before the keyboard has finished
      // resizing. Repeat only when a visible-area change clips the input.
      const box = input.getBoundingClientRect();
      const top = viewport.offsetTop + 8;
      const bottom = viewport.offsetTop + viewport.height - 8;
      if (box.top < top || box.bottom > bottom) input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    const update = () => {
      frame = 0;
      // Pinch zoom must retain ordinary browser panning; it is not a keyboard.
      if (Math.abs(viewport.scale - 1) > .01) return;
      style.setProperty('--forge-visible-height', `${viewport.height}px`);
      style.setProperty('--forge-visible-top', `${viewport.offsetTop}px`);
      cancelAnimationFrame(revealFrame);
      revealFrame = requestAnimationFrame(reveal);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    schedule();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    document.addEventListener('focusin', schedule);
    return () => {
      cancelAnimationFrame(frame); cancelAnimationFrame(revealFrame);
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('focusin', schedule);
      style.removeProperty('--forge-visible-height'); style.removeProperty('--forge-visible-top');
    };
  }, []);
}
