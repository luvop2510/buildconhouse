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
      const update = () => {
        const input = document.activeElement;
        setActive(input instanceof HTMLElement && input.matches('input:not([type="button"]):not([type="checkbox"]):not([type="radio"]),textarea,[contenteditable="true"]'));
      };
      let blurTimer: ReturnType<typeof setTimeout>;
      // Let the blur-triggering tap finish before restored chrome moves its target.
      const afterBlur = () => { clearTimeout(blurTimer); blurTimer = setTimeout(update, 150); };
      const onFocus = () => {
        const element = document.activeElement;
        if (element instanceof HTMLElement && element.matches('input,textarea,[contenteditable="true"]')) { clearTimeout(blurTimer); update(); }
        else afterBlur();
      };
      document.addEventListener("focusin", onFocus);
      document.addEventListener("focusout", afterBlur);
      update();
      return () => {
        clearTimeout(blurTimer);
        document.removeEventListener("focusin", onFocus);
        document.removeEventListener("focusout", afterBlur);
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
