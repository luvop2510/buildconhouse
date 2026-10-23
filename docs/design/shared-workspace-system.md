# Shared workspace design system

Ground, Sanitary, Kitchen and Furniture share the application shell, accessible controls and data table contract. Floor-specific business fields and permissions remain separate. Kitchen uses the scoped workspace presentation in `src/components/kitchen/KitchenPrimitives.tsx`; shared primitives remain in `src/components/ui.tsx`, re-exported from `src/components/ds.tsx`.

## Page and task hierarchy

Use one page title and one primary task action. Keep contextual customer identity, phone and site visible above the current task. Put secondary actions in the page header or a labelled menu. Header and content should share the same scrolling region on compact screens, with consistent aligned gutters. Preserve the component tree across rotation so typed drafts survive.

Kitchen's page frame supports a contained 1,560 px maximum width, 16 px phone gutters and 32 px regular gutters. Its title block wraps header actions onto another line when the remaining content width cannot support both. Its task text uses a 16/24 px body scale, 20/28 px section heading and 26–28 px page heading. Use white sections and thin separators instead of multiple competing elevated cards.

## Controls and feedback

Interactive targets have a minimum 44 px touch region. Text fields have visible persistent labels, a 48 px minimum height and a 16 px input font. Related fields can share a row only when each remains usable; otherwise wrap. Required values and errors must be expressed in text. Keep loading buttons disabled while their request runs, preserve draft values after failures and provide a retry or reload path.

Keyboard focus uses a visible blue outline without changing the element's dimensions. Focus, press and hover states must not move neighbouring controls. Respect reduced motion and do not rely on animation, icons or colour alone to communicate state. Date-only values stay in India time and use browser-native calendar inputs on web.

Kitchen's measured text pairs are ink `#17232E` on white (15.95:1), muted `#53616F` on white (6.35:1), muted text on `#F6F7F9` (5.92:1) and white on action blue `#0066CC` (5.57:1). All exceed 4.5:1 for ordinary text.

## Data tables across all floors

Import `Table`, `TableHeader`, `TableRow` and `TableCell` from the shared design-system entry point. `Table` owns its bounded horizontal scroll region; do not add a second horizontal `ScrollView` or manually sum column widths. Give each table a descriptive `accessibilityLabel` and preserve a stable `testID` when callers or browser checks need it. The scroll region is keyboard focusable and retains a visible scrollbar. With the region itself focused, Left/Right move horizontally and Home/End reach the first/last column. Keys originating from child links or fields, modified shortcuts and vertical scrolling keys retain their normal behaviour.

Header and body columns must have the same `width` or `flex` values. Fixed widths remain fixed; flexible columns share the available space using a zero flex basis. The table minimum width includes every column, every inter-column gap, both row gutters and the outer border. Flexible columns reserve 120 px per flex unit before horizontal scrolling becomes necessary. `tableMinWidth` in `src/components/tableLayout.ts` is the shared calculation; it is also exported through the design-system entry point.

Specialized tables that retain their own scroll region use the same `handleTableScrollKey` helper, a descriptive label, a focusable web scroll region and table semantics. Furniture's currency ledger and Ground's Tile Orders table follow this contract. Home/End and Left/Right operate only when the region itself has focus; child controls and modified shortcuts retain their normal keys.

Cells constrain their direct content and links to the column width, retain shrinkable containers and wrap plain strings, long identifiers and URLs. Row height grows with text; neither the table nor cell clips essential content. Use caller-specified truncation only for secondary information with an accessible way to read the full value. Do not put fixed-height containers around multiline cells. Right-aligned numeric cells retain their header alignment.

Very narrow views may use labelled record lists when the complete record remains available. This is a presentation change: preserve the same filters, sorting, counts, actions and navigation destinations. A table selected on a regular screen must not create page-level horizontal overflow.

## Verification

- `npm run test:table-layout` checks fixed, mixed and flexible column calculations, including zero-width semantics, and exercises horizontal key handling, bounds, child controls and modified shortcuts.
- Browser acceptance must use long, populated names and identifiers; empty tables cannot demonstrate correct layout.
- Verify header/body alignment, text containment, keyboard access to the last column and absence of page-level overflow.
- Check phone, tablet, desktop and landscape widths, plus rotation while editing a populated form.
- Build and test an immutable export of the current source before publication; do not reuse an older preview as release evidence.

## Reference principles

These web and React Native rules apply Apple's accessibility, layout, typography, colour, buttons, data-entry and picker principles, and the UI/UX Pro Max accessibility/responsive guidance. They do not impose macOS menu-bar or native iOS navigation conventions on the web application. Product-specific layout decisions above are implementation judgments, not Apple certification.
