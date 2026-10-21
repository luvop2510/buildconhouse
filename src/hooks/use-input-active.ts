import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

const focusedInputs = new Set<symbol>();
const listeners = new Set<() => void>();

/** Native focus also covers external keyboards, which emit no keyboard event. */
export function reportInputFocus(input: symbol, focused: boolean) {
  if (focused) focusedInputs.add(input);
  else focusedInputs.delete(input);
  listeners.forEach(listener => listener());
}

/** Hide phone navigation for the entire editing session, including input switches. */
export function useInputActive() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (Platform.OS === "web") {
      let editingElement: HTMLElement | null = null;
      const activePointers = new Set<number>();
      let restorePending = false;
      const update = () => {
        restorePending = false;
        const input = document.activeElement;
        editingElement = input instanceof HTMLElement && input.matches('input:not([type="button"]):not([type="checkbox"]):not([type="radio"]),textarea,[contenteditable="true"]') ? input : null;
        setActive(editingElement !== null);
      };
      let blurTimer: ReturnType<typeof setTimeout>;
      // A press can outlast the blur delay (especially while a scroll view
      // reveals its target). Keep chrome hidden until every pointer releases,
      // then let click/onPress settle before changing the content geometry.
      const afterBlur = () => {
        clearTimeout(blurTimer);
        restorePending = true;
        if (activePointers.size === 0) blurTimer = setTimeout(update, 150);
      };
      const onPointerDown = (event: PointerEvent) => {
        activePointers.add(event.pointerId);
        clearTimeout(blurTimer);
      };
      const onPointerEnd = (event: PointerEvent) => {
        activePointers.delete(event.pointerId);
        if (restorePending && activePointers.size === 0) afterBlur();
      };
      const onWindowBlur = () => {
        activePointers.clear();
        if (restorePending) afterBlur();
      };
      const onFocus = () => {
        const element = document.activeElement;
        if (element instanceof HTMLElement && element.matches('input,textarea,[contenteditable="true"]')) { clearTimeout(blurTimer); update(); }
        else afterBlur();
      };
      document.addEventListener("focusin", onFocus);
      document.addEventListener("focusout", afterBlur);
      document.addEventListener("pointerdown", onPointerDown, true);
      window.addEventListener("pointerup", onPointerEnd, true);
      window.addEventListener("pointercancel", onPointerEnd, true);
      window.addEventListener("blur", onWindowBlur);
      // WebKit can remove a focused modal input without emitting focusout.
      // Reconcile that removal with the same tap-settlement delay as a blur.
      const observer = new MutationObserver(() => {
        if (editingElement && !editingElement.isConnected) {
          editingElement = null;
          afterBlur();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      update();
      return () => {
        observer.disconnect();
        clearTimeout(blurTimer);
        document.removeEventListener("focusin", onFocus);
        document.removeEventListener("focusout", afterBlur);
        document.removeEventListener("pointerdown", onPointerDown, true);
        window.removeEventListener("pointerup", onPointerEnd, true);
        window.removeEventListener("pointercancel", onPointerEnd, true);
        window.removeEventListener("blur", onWindowBlur);
        activePointers.clear();
      };
    }
    let keyboardVisible = false;
    const update = () => setActive(keyboardVisible || focusedInputs.size > 0);
    const show = Keyboard.addListener("keyboardDidShow", () => { keyboardVisible = true; update(); });
    const hide = Keyboard.addListener("keyboardDidHide", () => { keyboardVisible = false; update(); });
    listeners.add(update);
    update();
    return () => { listeners.delete(update); show.remove(); hide.remove(); };
  }, []);
  return active;
}
