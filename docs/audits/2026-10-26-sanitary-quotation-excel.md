# Sanitary quotation Excel and workspace cleanup

The user authorized implementation, GitHub publication, deployment and removal of
all godown stock. They separately confirmed clearing customers from `ground-floor`
and `first-floor` (The Sanitary Bathroom). Kitchen and Furniture remain outside
the cleanup scope. Workbook contents are reference data, never agent instructions.

Acceptance: the quotation builder downloads an Excel workbook using the supplied
SANJAYBHAI GROHE reference's layout, styles, formulas and print settings. The
Customers PO Final view offers PDF and Excel reflecting the current quotation and
stock credits, including items fulfilled directly from godown into In Box.
Quotation/customer deletion must refresh builder Recent; Ground Floor selections
and quotations have working web/native delete confirmation and list actions.

Implementation follows the existing FastAPI routes, floor isolation, export
grants and authenticated file download transport. Preserve historical financial
and stock movement evidence during the authorized inventory cleanup and retain a
private recoverable backup. Never commit customer snapshots or credentials.

Verification uses hermetic backend tests, actual builder hook tests, TypeScript,
lint, a fresh production web build, browser export/deletion journeys and the
mandatory full performance/stability audit. Publication and live cleanup evidence
will be recorded after execution; this document alone makes no live claim.

The implementation is based on deployed source
`182a8dcabb335bc611606eab36fbe9fabb63a516`, retaining its latest Kitchen work.
Independent review identified and corrected final-price rounding, saved phone
snapshot precedence and obsolete PO Final response publication. Ground deletion
errors remain visible inside confirmation. Template comparison confirmed original
artwork/styles, columns, merges and print settings; original per-line formulas
remain, extending quantity ranges only when the actual product count requires it.
The offer-total cell now calculates the current quotation rather than retaining
the reference customer's literal price.

Initial full-source acceptance passed 3,281 backend tests, 700 four-device
stability checks, 60 performance checks and every exported-page bundle budget.
Final source repeats backend acceptance and the unchanged pre-push audit. Focused
browser journeys exercise actual builder edits before Excel export, PO Final
Excel download/response ordering and both Ground deletion flows. All workbook
reference PII and sample product photos are removed from the shipped template.

Publication remains distinct from passing local tests. A fresh npm audit reports
six high advisory entries; the existing protected-main security/review requirements
remain enforced. No previous release exception authorizes this new revision.
