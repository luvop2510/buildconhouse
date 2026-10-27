# Sales workspace design contract

The daily task is to understand product/brand sales, referral relationships, and
customer follow-through without choosing among overlapping analytics reports.

- Three destinations: Sales, References, Customers. Legacy report bookmarks
  redirect to their relevant destination. Brand/reference details remain.
- Sales answers which products and brands sold, and in what quantities. Revenue,
  confirmed orders and distinct products lead. Boxes and pieces remain separate.
- References answers who introduced customers. Architect/interior directory data
  loads independently of revenue. Search includes names, studios, phone and code;
  create/edit retains identity and explicit sharing scope.
- Customers answers how many buyers, open follow-ups and unpaid balances exist.
  Buyer activity follows the sales period; follow-ups and balances are current.
- A report floor and period persist between views. Obsolete responses never
  publish into a new scope. Operational actions choose a concrete business unit.
  An unsaved period starts at This month; catalog-only smart fallback is not used
  for a report that includes Kitchen orders and Furniture ledgers.
- Compact width: one title/action row, filters collapsed initially, revenue followed
  by product/order figures, lists with wrapping identity and labelled amounts.
- Regular width: quiet neutral tabs, compact floor/date controls, one summary band
  and side-by-side brand/product lists within one shared surface.
- No health score, forecast, supplier placeholder, priority feed or duplicated
  overview. No decorative icons on metrics or invented growth comparisons.

Direction: Achromatic ledger, seed 1455220230, existing Inter/blue tokens retained.
Identity: BuildCon's actual product/brand names and separate box/piece quantities,
with its blue on brand contribution bars. Navigation is neutral.

Reference guidance read: Apple accessibility, layout, typography, color,
designing-for-ios, lists-and-tables, charting-data, searching and cross-platform.
These web views use the foundation principles, not native macOS menu conventions.
`charting-data.md › Best practices`: “Keep a chart simple, letting people choose
when they want additional details.” Ranked lists and exact values implement this.

Color pairs: primary #101828, secondary #475467, small labels #667085 on white
and #F7F8FA; accent #0066CC on white. Existing Feather icons are retained beside
labels. The inspector counts Inter weight files as different typefaces; its
font-count allowance is restricted to that measurement (one Inter family and an
icon font), rather than substituting fonts or suppressing readability checks.

Coverage: all four departments. Tiles/Sanitary use confirmed quotations; Kitchen
uses confirmed project orders pinned to their selected quotation/design versions;
Furniture uses finalized RNB ledgers. INR and RNB are always separate totals and
customer balance rows. Products/brands apply only to actual catalog line items;
Kitchen/Furniture views retain financial and customer information without invented
product attribution. Kitchen collected money is limited to recorded advances,
which is made explicit in the report. Current balances span all dates.
