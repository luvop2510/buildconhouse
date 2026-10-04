// Responsive helpers for the Quotation Builder product grid.
// Measure the browsing pane: a tablet picker can use the whole screen while
// an inline catalog shares space with the quotation. Keep phone cards usable
// and use the extra tablet width for more visible products.
export function quotationGridColumns(width: number, desktopExplorer = false): 1 | 2 | 3 | 4 | 5 {
  // 280px is below the narrowest supported mobile content area, but retaining
  // a single-column fallback means the layout is still usable in an embedded
  // or exceptionally narrow web view.
  if (width >= 720) return 5;
  if (desktopExplorer && width >= 520) return 5;
  if (width >= 576) return 4;
  if (width >= 480 || (desktopExplorer && width >= 420)) return 3;
  if (width >= 280) return 2;
  return 1;
}
