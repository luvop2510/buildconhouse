import { useEffect, useRef } from "react";
import { Alert, Platform } from "react-native";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { usePathname } from "expo-router";

let historyIndexed = false;
let historyPosition = 0;
/** Preserve browser entry positions so declining Back restores the same entry. */
function indexBrowserHistory() {
  if (historyIndexed) return;
  historyIndexed = true;
  const push = window.history.pushState.bind(window.history);
  const replace = window.history.replaceState.bind(window.history);
  historyPosition = window.history.state?.kitchenPosition ?? 0;
  replace({ ...window.history.state, kitchenPosition: historyPosition }, "");
  window.history.pushState = (state, title, url) => { historyPosition += 1; push({ ...state, kitchenPosition: historyPosition }, title, url); };
  window.history.replaceState = (state, title, url) => replace({ ...state, kitchenPosition: historyPosition }, title, url);
  window.addEventListener("popstate", event => { historyPosition = event.state?.kitchenPosition ?? historyPosition - 1; });
}

/** Drafts remain in memory on sibling pages. Leaving their scope requires a decision. */
export function useKitchenExitGuard({ dirty, scope }: { dirty: boolean; scope: string }) {
  const navigation = useNavigation();
  const pathname = usePathname();
  const approved = useRef(false);
  const position = useRef(0);
  const message = "You have unsaved Kitchen changes. Leave and discard these changes?";
  usePreventRemove(dirty, ({ data }) => {
    const leave = () => { approved.current = true; navigation.dispatch(data.action); };
    if (approved.current) { navigation.dispatch(data.action); return; }
    if (Platform.OS === "web") {
      if (window.confirm(message)) leave();
    } else {
      Alert.alert("Unsaved changes", message, [{ text: "Keep editing", style: "cancel" }, { text: "Discard and leave", style: "destructive", onPress: leave }]);
    }
  });
  useEffect(() => {
    if (Platform.OS !== "web") return;
    indexBrowserHistory();
    position.current = window.history.state?.kitchenPosition ?? historyPosition;
    if (!dirty) return;
    let restoring = false;
    const unload = (event: BeforeUnloadEvent) => {
      if (approved.current) return;
      event.preventDefault(); event.returnValue = "";
    };
    const click = (event: MouseEvent) => {
      if (!(pathname === scope || pathname.startsWith(`${scope}/`))) return;
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const target = new URL(anchor.href, window.location.href);
      if (target.origin === window.location.origin && (target.pathname === scope || target.pathname.startsWith(`${scope}/`))) return;
      if (!window.confirm(message)) { event.preventDefault(); event.stopPropagation(); }
      else approved.current = true;
    };
    const pop = (event: PopStateEvent) => {
      if (restoring) { restoring = false; event.stopImmediatePropagation(); return; }
      const target = window.location.pathname;
      if (approved.current || target === scope || target.startsWith(`${scope}/`)) return;
      if (window.confirm(message)) { approved.current = true; return; }
      event.stopImmediatePropagation();
      const targetPosition = event.state?.kitchenPosition ?? position.current - 1;
      restoring = true;
      window.history.go(position.current - targetPosition);
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    window.addEventListener("popstate", pop, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", click, true); window.removeEventListener("popstate", pop, true); };
  }, [dirty, scope, pathname]);
  useEffect(() => { approved.current = false; }, [pathname]);
  useEffect(() => { if (!dirty) approved.current = false; }, [dirty]);
  return { allowLeave: () => { approved.current = true; } };
}
