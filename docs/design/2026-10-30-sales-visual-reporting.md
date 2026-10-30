# Sales visual reporting

Sales Data gives the owner a quick, reliable picture of showroom sales and a path
to the records behind it. The signature is a compact sales trend beside labelled
floor contribution, followed by collections and ranked showroom products. Charts
explain real relationships; no synthetic scores, targets or decorative growth.

## Design decisions

The existing interface needs less vertical chrome and tablet stacking. Reuse its
system typography and semantic tokens, with no new dependency or visual theme.
The supplied vasnev.art AnalyticsBento is adapted into
`src/components/ui/analytics-bento.tsx`: its four-card composition, squarified
treemap geometry, mirrored comparison and radial axes use real scoped sales.
React Native primitives replace Tailwind DOM classes; no framework migration is
needed. Its demo session counts, artificial yearly data, perpetual animation and
rounded count-up money are replaced by exact accessible report values.
The second supplied `dashboard-1` component is adapted in the same UI directory:
its activity progress strip, initials stack and disclosure action summarize real
follow-up counts and current assignees. Hours and productivity are not inferred.
The phone layout removes the repeated brand line, uses one scope control and a
44px navigation strip, and puts a real mini bar chart beside the sales amount.
Team details expand on demand so they do not crowd the sales overview.
White surfaces on #F5F5F7, #1D1D1F content (16.83:1 on white), #545458 secondary
text (7.54:1), #0066CC chart/action blue (5.57:1), and labelled semantic signals
remain canonical. The app has a light theme; this work does not introduce a partial
dark theme. Data uses tabular figures. Compact headings are 20/28px, supporting
text 14/20px, chart labels at least 12px; inputs retain 16px and targets 44px.

Compact layout:

```text
[Company overview      Refresh]
[Period / filters       Export]
[Sales / orders / customers   ]
[Sales trend                  ]
[Floor share / collection bars]
[Ranked products and companies]
```

Regular layout:

```text
[Company overview                     Refresh]
[Period / filters                      Export]
[Sales       Orders       Customers       AOV]
[Sales trend                    ][Floor share]
[Floor comparison               ][Collections]
[Leading companies              ][Top products]
```

Layout follows available width and text scale. At the smallest widths complete
financial values take precedence over a fixed column count. Tables may scroll
inside their own frame. Charts retain labels, keyboard access and data alternatives.
No decorative motion is necessary. Remove repeated prose and empty space before
removing useful context. The product-specific floor and currency comparison makes
this more useful than a generic KPI-card template.

## Export contract

PDFs use portrait A4 (210 × 297mm), vector infographics and selectable text. The
first page summarizes the selected report; supporting pages combine graphical
context with readable tables and repeated scope/page information. Preserve report
filters, row caps, source totals, unknown values and separate INR/RNB ledgers.
Excel retains its complete tabular export. No customer data is rewritten.

Apple reference rationale: `layout.md › Visual hierarchy` says “Use progressive
disclosure to make layouts cleaner and easier to interact with.”
`charting-data.md › Best practices` says “Match the size of a chart to its
functionality, topic, and level of detail.” `accessibility.md › Mobility` gives
44 × 44pt as the default mobile control size. These principles are translated to
React Native/Web; native-only conventions do not apply to browser controls.

Acceptance focuses on 320/375/768/1024/1440px, enlarged text, source drilldowns,
exports, A4 geometry, long labels, missing/zero data and currency separation.
