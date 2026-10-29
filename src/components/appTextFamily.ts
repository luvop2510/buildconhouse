/** Use the operating system UI face; Apple devices resolve this to San Francisco. */
export const WEB_SYSTEM_FONT_STACK = '-apple-system, BlinkMacSystemFont, system-ui, sans-serif';

export function systemTextFamily(platform: string): string {
  return platform === "web" ? WEB_SYSTEM_FONT_STACK : platform === "android" ? "sans-serif" : "System";
}

/** Keep explicit icon families intact. Font weight belongs to the text style. */
export function appTextFamily(
  style?: { fontFamily?: string; fontWeight?: string | number } | null,
  platform = "ios",
): string {
  return style?.fontFamily || systemTextFamily(platform);
}
