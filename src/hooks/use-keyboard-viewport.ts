import { useEffect } from 'react';
import { Platform } from 'react-native';

const editableSelector = [
  'input:not([type="button"],[type="checkbox"],[type="radio"],[type="file"],[type="range"],[type="date"],[type="time"],[type="color"],[readonly],[disabled],[inputmode="none"])',
  'textarea:not([readonly],[disabled],[inputmode="none"])',
  '[contenteditable="true"],[contenteditable="plaintext-only"]',
].join(',');

function activeEditor() {
  const element = document.activeElement;
  return element instanceof HTMLElement && element.matches(editableSelector) ? element : null;
}

function visibleArea() {
  const viewport = window.visualViewport;
  return {
    height: viewport?.height ?? window.innerHeight,
    width: viewport?.width ?? window.innerWidth,
    top: viewport?.offsetTop ?? 0,
    zoomed: Math.abs((viewport?.scale ?? 1) - 1) > .01,
  };
}

/** Mobile browsers can keep the layout viewport tall when their keyboard opens.
 * Size the app and modal portals to the visible area, without rerendering pages.
 */
export function useKeyboardViewport() {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const viewport = window.visualViewport;
    const root = document.documentElement;
    const { style } = root;
    const hasTouch = window.matchMedia('(any-pointer: coarse)').matches || navigator.maxTouchPoints > 0;
    let keyboardOpen = false;
    let restingHeight = 0;
    let lastWidth = -1;
    let textareaObserver: ResizeObserver | undefined;
    let frame = 0;
    let revealFrame = 0;
    let revealPending = false;
    let lastHeight = -1;
    let lastTop = -1;
    const reveal = () => {
      revealFrame = 0;
      const input = activeEditor();
      const area = visibleArea();
      if (!input || area.zoomed) return;
      const option = input.closest('[data-reveal-first-option="true"]')?.querySelector('[data-reveal-option="true"]');
      // Browser focus scrolling happens before the keyboard has finished
      // resizing. Repeat only when a visible-area change clips the input.
      const clips: { element: HTMLElement; scrollable: boolean }[] = [];
      for (let parent = input.parentElement; parent; parent = parent.parentElement) {
        const overflow = window.getComputedStyle(parent).overflowY;
        if (/auto|scroll|hidden|clip/.test(overflow)) clips.push({ element: parent, scrollable: /auto|scroll/.test(overflow) });
      }
      // Scroll the form, never the document: scrollIntoView can pan Safari's
      // entire fixed application. A second pass handles a previously clipped inner panel.
      for (let pass = 0; pass < 2; pass++) for (let index = 0; index < clips.length; index++) {
        const { element: parent, scrollable } = clips[index];
        if (parent === document.body || parent === document.documentElement || parent.id === 'root'
          || !scrollable
          || parent.scrollHeight <= parent.clientHeight) continue;
        let top = area.top + 8;
        let bottom = area.top + area.height - 8;
        // Descendant scrollports move with this parent. Including their
        // current bounds can make the intersection empty when an inner form
        // is entirely offscreen, preventing the outer form from revealing it.
        for (let ancestor = index; ancestor < clips.length; ancestor++) {
          const clip = clips[ancestor].element;
          const bounds = clip.getBoundingClientRect();
          top = Math.max(top, bounds.top + clip.clientTop + 8);
          bottom = Math.min(bottom, bounds.top + clip.clientTop + clip.clientHeight - 8);
        }
        const outside = bottom <= top;
        if (outside) {
          // First reveal within an offscreen inner scrollport; its outer
          // scrollport can then bring that field into the visible viewport.
          const bounds = parent.getBoundingClientRect();
          top = bounds.top + parent.clientTop + 8;
          bottom = bounds.top + parent.clientTop + parent.clientHeight - 8;
          if (bottom <= top) continue;
        }
        const box = input.getBoundingClientRect();
        const optionBottom = option?.getBoundingClientRect().bottom ?? box.bottom;
        const combinedBottom = Math.max(box.bottom, optionBottom);
        const targetBottom = combinedBottom - box.top <= bottom - top ? combinedBottom : box.bottom;
        const delta = box.height > bottom - top || box.top < top
          ? box.top - top
          : Math.max(0, targetBottom - bottom);
        if (delta === 0) {
          if (index === 0 && !outside) return;
          continue;
        }
        const change = Math.max(-parent.scrollTop, Math.min(delta, parent.scrollHeight - parent.clientHeight - parent.scrollTop));
        if (change !== 0) parent.scrollTop += change;
      }
    };
    const update = () => {
      frame = 0;
      const { height, width, top, zoomed } = visibleArea();
      // Pinch zoom retains ordinary browser panning.
      if (zoomed || height <= 0) return;
      const resized = height !== lastHeight;
      const shrank = height < lastHeight;
      if (resized) style.setProperty('--forge-visible-height', `${height}px`);
      if (top !== lastTop) style.setProperty('--forge-visible-top', `${top}px`);
      if (Math.abs(width - lastWidth) > 1) restingHeight = height;
      const input = activeEditor();
      if (hasTouch && resized && (input || keyboardOpen)) {
        // Small viewport units exclude browser toolbar travel. With Chromium
        // resizes-content, both viewport sizes shrink, so compare against the
        // last settled height for this width as well.
        const smallHeight = parseFloat(window.getComputedStyle(root, '::before').height);
        const belowBrowserChrome = Number.isFinite(smallHeight) && height < smallHeight - 1;
        const contentResized = height < restingHeight * .8;
        const open = belowBrowserChrome || contentResized;
        if (open !== keyboardOpen) {
          keyboardOpen = open;
          if (open) root.setAttribute('data-keyboard-open', 'true');
          else root.removeAttribute('data-keyboard-open');
          document.dispatchEvent(new Event(open ? 'forge:keyboard-open' : 'forge:keyboard-closed'));
        }
      }
      if (!keyboardOpen && (!input || height > restingHeight)) restingHeight = height;
      lastHeight = height;
      lastWidth = width;
      lastTop = top;
      if (revealPending || shrank) {
        cancelAnimationFrame(revealFrame);
        revealFrame = requestAnimationFrame(reveal);
      }
      revealPending = false;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    // Scroll events align the portal with Safari's visual viewport pan.
    // They never trigger reveal, so the user can freely scroll the form.
    const requestReveal = () => { revealPending = true; schedule(); };
    const onFocus = () => {
      textareaObserver?.disconnect();
      const input = activeEditor();
      if (input?.matches('textarea,[contenteditable]') && typeof ResizeObserver !== 'undefined') {
        // Growing notes can change clipping without a viewport resize.
        let height = input.getBoundingClientRect().height;
        textareaObserver = new ResizeObserver(() => {
          const nextHeight = input.getBoundingClientRect().height;
          if (nextHeight !== height && activeEditor() === input) requestReveal();
          height = nextHeight;
        });
        textareaObserver.observe(input);
      }
      requestReveal();
    };
    onFocus();
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('forge:reveal-focused-input', requestReveal);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(revealFrame);
      textareaObserver?.disconnect();
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('forge:reveal-focused-input', requestReveal);
      root.removeAttribute('data-keyboard-open');
      style.removeProperty('--forge-visible-height');
      style.removeProperty('--forge-visible-top');
    };
  }, []);
}
