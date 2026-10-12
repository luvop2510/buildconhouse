// grabCursor — web-only cursor hint on drag handles. Silently ignored on native.
import { Platform } from "react-native";

export const grabCursor: any = Platform.OS === "web" ? { cursor: "grab", touchAction: "none" } : null;
