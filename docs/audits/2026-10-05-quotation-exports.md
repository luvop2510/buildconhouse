# Quotation export review — 2026-10-05

## Resulting behavior

- A sanitary customer PPT contains the cover and exactly one slide per nonempty room/bathroom. All selected products fit in contained, aligned grids; additional custom areas occupy bands on that same slide.
- Room names are trimmed consistently. Duplicate declared rooms cannot duplicate a slide, and whitespace-only or undeclared room names cannot lose selected products.
- Products follow persisted sort order within their area. Portrait, landscape and transparent images retain their proportions and remain uncropped.
- The PPT includes exact-product seat-cover photos and ordinary concealed-part selections. A legacy concealed article without media rows can use its own stored product images, only when its SKU and quotation floor match.
- Quotation read/list, creation/update and PDF/PPT paths prove current-image ownership against the exact product SKU and document floor. Malformed historic references to another floor cannot render either their current hero or saved snapshot. The existing catalog snapshot handles ownership and media without another Atlas roundtrip; list pages resolve their items in one batch per floor. Retired/manual product snapshots remain intact.
- Unique product images are normalized once per export and capped at 1,600 pixels per edge. This reduces both server image processing and the amount PowerPoint needs to decode on a tablet.
- PDF options refer to product dimension diagrams, because the backend supports any brand.

## Verification

| Check | Result |
| --- | --- |
| Focused backend PDF/PPT/media/security regressions | 104 passed; quotation list ownership regression additionally verified |
| PDF/PPT download browser journeys | 16 passed across all eight release profiles |
| Mobile browser download contract | PDF and PPT passed for iPhone, Android, embedded browsers and iPad desktop user agents; failures and cancellation recover |
| Quotation media helpers | 46 assertions passed |
| Quotation concealed/default-included parts contract | Passed |
| Shared quotation totals/autosave contract | Passed |
| Python static analysis for changed export modules/tests | Passed |
| Generated dense-room PPT | Three slides: cover, 17 selected Master Bathroom products plus a seat photo, one Powder Room product |
| Actual deck rendering | LibreOffice converted the PPT to three PDF pages; the dense room was rasterized and visually reviewed for fit and overlap |
| Sanitary PDFs, with/without dimensions | Every selected SKU and concealed-part description present; large Indian currency amounts remain intact |
| Tile selection/quotation PDFs | Every product detail present; portrait/landscape source images render |

The geometry regressions verify seven, 17, 36 and 60 selections, with one to six area groups. Every picture remains inside its slide, has zero crop, and does not overlap another picture.

`backend/scripts/verify_quotation_exports.py` reproduces the actual review artifacts without database connections, credentials or network requests. Generated files are in ignored `output/exports/2026-10-05/`, including the PPT, its rendered PDF, all four quotation PDF variants, review PNGs and verification JSON. The browser journeys intercept synthetic API responses; attachment behavior is exercised independently from the actual document-content tests. No production customer or order data was created or changed.

## Performance evidence and limits

A local, single-run CPU comparison against the previous committed PPT generator used 24 selections of one synthetic 2,000×1,200 PNG, with networking disabled. Generation decreased from 12,441 ms to 228 ms; the deck decreased from 4,355,518 to 2,529,272 bytes, and seven slides became the required cover plus one room slide. This demonstrates the repeated normalization fix on that fixture; it is not a production latency or network benchmark. The separate dense-room fixture generated in 299 ms and occupied 296,891 bytes.

PDF detail tables continue onto additional pages when necessary to retain readable product/pricing rows; the one-room/one-page requirement applies to the image-led PPT. This review does not certify physical iPad/Android/PowerPoint devices. Storage photos that are missing or unavailable remain explicit placeholders; the 2026-10-04 catalog report's unresolved exact-source Vitra media references require source recovery, not a substitute product photo.
