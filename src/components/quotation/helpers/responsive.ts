// Responsive helpers for the Quotation Builder product grid.
// The picker is deliberately a two-column, shop-style catalog on every
// supported phone and tablet width.  This keeps four choices visible in the
// first product viewport instead of dedicating the whole surface to one item.
export function quotationGridColumns(width: number, desktopExplorer = false): 1 | 2 | 3 | 4 | 5 {
  // 280px is below the narrowest supported mobile content area, but retaining
  // a single-column fallback means the layout is still usable in an embedded
  // or exceptionally narrow web view.
  // On the desktop explorer, product cards are deliberately compact enough
  // for five real choices to be visible across the browsing pane. Keep the
  // phone/tablet picker at two columns where touch targets need more room.
  if (desktopExplorer && width >= 520) return 5;
  if (desktopExplorer && width >= 420) return 3;
  if (width >= 280) return 2;
  return 1;
}
