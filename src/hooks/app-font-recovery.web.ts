const RETRY_KEY = "forge:retry-app-fonts";

/** A failed Safari font URL can remain cached even after reloading the page. */
export function reloadAppFonts() {
  try { sessionStorage.setItem(RETRY_KEY, String(Date.now())); } catch { /* Storage can be disabled. */ }
  window.location.reload();
}

export function retryBrowserFontSources(families: string[]) {
  let retry: string | null = null;
  try {
    retry = sessionStorage.getItem(RETRY_KEY);
    sessionStorage.removeItem(RETRY_KEY);
  } catch { /* Ordinary font loading still works without browser storage. */ }
  if (!retry) return;
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of Array.from(rules)) {
      if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
      const style = (rule as CSSFontFaceRule).style;
      if (!families.includes(style.fontFamily.replace(/["']/g, ""))) continue;
      const match = /url\(["']?([^"')]+)["']?\)/.exec(style.getPropertyValue("src"));
      if (!match) continue;
      const asset = new URL(match[1], window.location.href);
      if (asset.origin !== window.location.origin) continue;
      asset.searchParams.set("font_retry", retry);
      style.setProperty("src", `url("${asset.href}")`);
    }
  }
}
