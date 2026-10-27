// frontend/src/components/tiles/TileTable.tsx
// The one data-table used by every Tile Orders screen.
//
// Why a component and not four hand-rolled grids: every Tile Orders page
// previously built its own header row and its own body rows out of loose
// <Text style={[styles.someCol, ...]}> pairs. Keeping the two in sync was
// manual, so they drifted — the header `gap` had to be re-matched to the row
// `gap` by hand (see the comments this replaces), and a column label could
// sit a full column away from the data it named. Here a column is declared
// ONCE and both the header cell and the body cell read their width and
// alignment from that single declaration, so drift is structurally
// impossible rather than merely discouraged.
//
// Layout contract (warehouse ERP density — dense, never cramped):
//   header      48px, sticky on web, uppercase micro-label
//   row         56px default, hover + selected states
//   cell        16px horizontal padding on every cell, no inter-cell `gap`
//   numeric     right aligned, tabular figures
//   status      centered
//   actions     fixed width, never shrinks
// Columns marked `grow` absorb leftover width so a wide monitor fills out
// instead of leaving a dead right-hand margin.
import { type ReactNode, useRef, useState } from "react";
import { FlatList, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { handleTableScrollKey } from "@/src/components/tableLayout";

import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

export type ColumnAlign = "left" | "right" | "center";

export type Column<T> = {
  key: string;
  label: string;
  /** Fixed width in px. Use for numerics, status, dates and action clusters. */
  width?: number;
  /** Share of the leftover width on wide screens. Use for names and descriptions. */
  grow?: number;
  /** Floor width for a `grow` column; also its contribution to the scroll threshold. */
  minWidth?: number;
  align?: ColumnAlign;
  /**
   * Pins the column to the right edge so it stays visible while the rest of
   * the table scrolls under it. Use for the action cluster on a table too wide
   * to fit: the whole point of an operations screen is that the operator can
   * always reach the verbs, and scrolling sideways to find "Dispatch from
   * Godown" is what made this module read as a report instead of a workspace.
   *
   * At most ONE column per table may set this. Every pinned cell anchors to
   * `right: 0`, so a second one would stack on top of the first rather than
   * beside it; supporting more would mean giving each a cumulative offset.
   *
   * Mutually exclusive with `fillViewport`. A pinned cell resolves `right: 0`
   * against the nearest scrolling ancestor, and `fillViewport` inserts a
   * vertical scroller between the cell and the horizontal one — so the pin
   * would anchor to the table's own right edge, which is where the column
   * already is. Pin the verbs on a workspace; scroll the body on a long list.
   */
  sticky?: boolean;
  /**
   * How this desktop column participates in the compact record card. Desktop
   * tables may carry many scanning columns; phones should lead with one
   * recognisable record, a few decision fields, then its verbs. Leaving this
   * unset retains the sensible `detail` default for older tables.
   */
  mobile?: "primary" | "detail" | "action" | "hidden";
  render: (row: T) => ReactNode;
};

const DEFAULT_COL_WIDTH = 120;

/** Scrollable row width that must remain visible beside a pinned column. */
const MIN_UNPINNED_WIDTH = 460;

/** A `fillViewport` table never collapses below this, however low it sits. */
const MIN_BODY_HEIGHT = 280;

/** Breathing room left under a `fillViewport` table's last row. */
const VIEWPORT_BOTTOM_GUTTER = 32;

/**
 * Wraps the header and rows in the vertical scroll region that makes the
 * header's `position: sticky` resolve — or renders them inline when the table
 * is meant to scroll with the page instead.
 */
function ScrollableBody({
  enabled, maxHeight, children,
}: { enabled: boolean; maxHeight: number; children: ReactNode }) {
  if (!enabled) return <>{children}</>;
  return (
    <ScrollView style={{ maxHeight }} nestedScrollEnabled>
      {children}
    </ScrollView>
  );
}

/** A column's contribution to the width at which the table starts scrolling. */
function columnFloor<T>(column: Column<T>): number {
  return column.width ?? column.minWidth ?? DEFAULT_COL_WIDTH;
}

function cellLayout<T>(column: Column<T>) {
  const align = column.align ?? "left";
  return {
    // A fixed column must neither grow nor shrink, otherwise the header cell
    // and the body cell resolve to different widths under pressure.
    flexGrow: column.grow ?? 0,
    flexShrink: 0,
    flexBasis: column.width ?? column.minWidth ?? DEFAULT_COL_WIDTH,
    ...(column.width != null ? { width: column.width } : null),
    ...(column.minWidth != null ? { minWidth: column.minWidth } : null),
    justifyContent: "center" as const,
    alignItems: align === "right" ? ("flex-end" as const)
      : align === "center" ? ("center" as const)
      : ("flex-start" as const),
  };
}

function textAlignFor(align: ColumnAlign | undefined) {
  return align === "right" ? ("right" as const)
    : align === "center" ? ("center" as const)
    : ("left" as const);
}

// `position: sticky` is web-only and absent from React Native's ViewStyle
// type, so it has to be cast. On native the header simply scrolls with the
// content, which is the correct native behaviour anyway.
const stickyHeader = Platform.OS === "web"
  ? ({ position: "sticky", top: 0, zIndex: 2 } as any)
  : null;

// Pinned column. zIndex sits above body cells so the scrolling content passes
// underneath, and the header's pinned cell sits above both.
const stickyRight = (zIndex: number) => (Platform.OS === "web"
  ? ({ position: "sticky", right: 0, zIndex } as any)
  : null);

const webCursor = (cursor: "pointer" | "default") =>
  (Platform.OS === "web" ? ({ cursor } as any) : null);

/**
 * A pinned cell cannot be transparent — the scrolling content would show
 * through it — so it has to repaint whatever background its row currently
 * has. That makes the row's resting/zebra/hover/selected colour a value the
 * table computes rather than a style it layers on.
 */
function rowBackground(index: number, selected: boolean, hovered: boolean) {
  if (selected) return colors.brandTint;
  if (hovered) return colors.surfaceTertiary;
  return index % 2 === 1 ? colors.surfaceSubtle : colors.surfaceSecondary;
}

export type DataTableProps<T> = {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (row: T, index: number) => string;
  onRowPress?: (row: T, index: number) => void;
  rowTestID?: (row: T, index: number) => string;
  /** A concise announcement for a row that opens another operational view. */
  rowAccessibilityLabel?: (row: T, index: number) => string;
  /** Marks a row as the current selection (persistent highlight + brass rule). */
  isRowSelected?: (row: T, index: number) => boolean;
  /** Taller rows for tables whose cells stack a title over a subtitle, or wrap action clusters. */
  rowMinHeight?: number;
  emptyMessage?: string;
  testID?: string;
  /**
   * Gives the table its own vertical scroll region sized to the rest of the
   * viewport, which is what makes the sticky header actually stick.
   *
   * `position: sticky` resolves against the nearest scrolling ancestor. With
   * the table simply sitting in the page's scroll flow, that ancestor was the
   * table's own clipping shell — which never scrolls — so the header scrolled
   * away with the page and the column names were gone by row 8. Scrolling the
   * body inside the table instead keeps the header, the toolbar and the tabs
   * all on screen, which is the behaviour a 100-row register needs.
   *
   * Leave off for short tables that should scroll with the page — the
   * per-brand tables on the customer workspace, for instance, where a fixed
   * height would strand each brand in its own little scrollbox.
   */
  fillViewport?: boolean;
  /**
   * `parent` is for a paginated table rendered in a route-level scroll view.
   * It keeps the route as the only vertical scroll owner; the table retains
   * its horizontal desktop overflow without creating a second vertical pan
   * responder on phones.
   */
  scrollOwner?: "self" | "parent";
};

export function DataTable<T>({
  columns, data, keyExtractor, onRowPress, rowTestID, rowAccessibilityLabel, isRowSelected,
  rowMinHeight = 56, emptyMessage = "Nothing to show yet.", testID, fillViewport,
  scrollOwner = "self",
}: DataTableProps<T>) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [bodyMaxHeight, setBodyMaxHeight] = useState<number | null>(null);
  const shellRef = useRef<View>(null);
  const windowHeight = useWindowDimensions().height;
  const { isPhone, bp } = useBreakpoint();
  // Sidebar expansion and nested cards change the usable table width without
  // changing the viewport tier. Keep names and actions readable in that space.
  const useCardRows = isPhone || (availableWidth > 0
    ? availableWidth < 900
    : bp === "tabletPortrait");
  const scrollThreshold = columns.reduce((total, column) => total + columnFloor(column), 0);

  // Pinning is only a help while the pinned column leaves room to read the
  // row it belongs to. A 524px action cluster pinned inside an 800px viewport
  // parks itself on top of every counter in the table — the data disappears
  // behind the buttons. So the pin engages only when at least
  // MIN_UNPINNED_WIDTH of scrollable row stays visible beside it; below that
  // the column rejoins the flow and the operator scrolls to it as normal.
  const stickyWidth = columns
    .filter((column) => column.sticky)
    .reduce((total, column) => total + columnFloor(column), 0);
  // Route-level pages own vertical movement for their paginated tables. Do
  // not let `fillViewport` silently introduce a second vertical responder
  // when such a table is rendered inside PageShell (especially on tablets).
  const innerScroll = Boolean(fillViewport) && bodyMaxHeight != null && scrollOwner === "self";
  const pinEnabled = !isPhone && stickyWidth > 0
    && !innerScroll
    && availableWidth > 0
    && availableWidth - stickyWidth >= MIN_UNPINNED_WIDTH;

  if (useCardRows) {
    const renderMobileRow = (item: T, index: number) => {
      const selected = isRowSelected?.(item, index) ?? false;
      const primary = columns.filter((column) => column.mobile === "primary");
      const details = columns.filter((column) => column.label && column.mobile !== "primary" && column.mobile !== "action" && (column.mobile !== "hidden" || !isPhone));
      const actions = columns.filter((column) => column.mobile === "action" || (!column.label && column.mobile !== "hidden"));
      const content = (
        <View style={styles.mobileCardContent}>
          {primary.map((column) => (
            <View key={column.key} style={styles.mobilePrimary}>{column.render(item)}</View>
          ))}
          {details.length ? (
            <View style={styles.mobileFields}>
              {details.map((column) => (
                <View key={column.key} style={styles.mobileField}>
                  <Text style={styles.mobileLabel}>{column.label}</Text>
                  <View style={styles.mobileValue}>{column.render(item)}</View>
                </View>
              ))}
            </View>
          ) : null}
          {actions.length ? (
            <View style={styles.mobileAction}>{actions.map((column) => <View key={column.key}>{column.render(item)}</View>)}</View>
          ) : null}
        </View>
      );
      if (!onRowPress) {
        return <View testID={rowTestID?.(item, index)} style={[styles.mobileCard, selected ? styles.bodyRowSelected : null]}>{content}</View>;
      }
      return (
        <Pressable
          testID={rowTestID?.(item, index)}
          onPress={() => onRowPress(item, index)}
          accessibilityRole="button"
          accessibilityLabel={rowAccessibilityLabel?.(item, index)}
          accessibilityHint="Opens details"
          style={({ pressed }) => [styles.mobileCard, selected ? styles.bodyRowSelected : null, pressed ? styles.bodyRowPressed : null]}
        >
          {content}
        </Pressable>
      );
    };

    return (
      <View
        ref={shellRef}
        style={[styles.mobileListShell, fillViewport && bodyMaxHeight ? { height: bodyMaxHeight } : null]}
        testID={testID}
        onLayout={(event) => {
          setAvailableWidth(event.nativeEvent.layout.width);
          if (!fillViewport) return;
          shellRef.current?.measureInWindow((_x, y) => {
            setBodyMaxHeight(Math.max(MIN_BODY_HEIGHT, windowHeight - y - VIEWPORT_BOTTOM_GUTTER));
          });
        }}
      >
        {scrollOwner === "parent" ? (
          // This table is inside PageShell's vertical ScrollView. Rendering
          // the paginated (30-row) page as ordinary views makes that shell
          // the only vertical scroll owner instead of nesting a FlatList.
          <View style={styles.mobileListContent}>
            {data.length === 0
              ? <View style={styles.mobileEmpty}><Text style={type.bodyMuted}>{emptyMessage}</Text></View>
              : data.map(renderMobileRow)}
          </View>
        ) : (
          <FlatList
            data={data}
            keyExtractor={keyExtractor}
            initialNumToRender={6}
            maxToRenderPerBatch={6}
            windowSize={5}
            contentContainerStyle={styles.mobileListContent}
            ListEmptyComponent={<View style={styles.mobileEmpty}><Text style={type.bodyMuted}>{emptyMessage}</Text></View>}
            renderItem={({ item, index }) => renderMobileRow(item, index)}
          />
        )}
      </View>
    );
  }

  return (
    <View
      ref={shellRef}
      role="table" aria-rowcount={data.length + 1} aria-colcount={columns.length}
      style={styles.shell}
      testID={testID}
      onLayout={(event) => {
        setAvailableWidth(event.nativeEvent.layout.width);
        if (!fillViewport) return;
        // Measured against the window rather than assumed, so the table works
        // under whatever page chrome sits above it on a given screen.
        shellRef.current?.measureInWindow((_x, y) => {
          setBodyMaxHeight(Math.max(MIN_BODY_HEIGHT, windowHeight - y - VIEWPORT_BOTTOM_GUTTER));
        });
      }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        testID={testID ? `${testID}-scroll` : undefined}
        accessibilityLabel="Tile orders table. Scroll horizontally for more columns."
        tabIndex={Platform.OS === "web" ? 0 : undefined}
        keyboardShouldPersistTaps="handled"
        {...(Platform.OS === "web" ? { onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => handleTableScrollKey(event) } : {})}
        contentContainerStyle={styles.hScrollContent}
      >
        {/* Width is stated explicitly rather than left at "100%".
            A horizontal ScrollView's content box shrink-wraps to its
            max-content width, and a cell's max-content includes the FULL
            untruncated product name — so a long name silently widened the
            table past the viewport and pushed the last column off screen even
            when the declared columns fitted. Pinning the width to
            max(available, floor) makes the row exactly as wide as the viewport
            when it fits and exactly the floor when it does not.

            `scrollThreshold` is derived from the columns themselves, so adding
            or resizing a column can never leave a stale hand-tuned constant
            behind — the old screens each carried one (1010/1080/1200/1620). */}
        <View
          style={[
            styles.table,
            { minWidth: scrollThreshold },
            // `availableWidth` is the shell's border-box width; its 1px
            // borders are not part of the scrollable content area.
            availableWidth > 0 ? { width: Math.max(availableWidth - 2, scrollThreshold) } : null,
          ]}
        >
          <ScrollableBody enabled={innerScroll} maxHeight={bodyMaxHeight ?? 0}>
          <View role="row" style={[styles.headerRow, innerScroll && !isPhone ? stickyHeader : null]}>
            {columns.map((column) => (
              <View
                key={column.key}
                role="columnheader"
                style={[
                  styles.cell,
                  cellLayout(column),
                  column.sticky && pinEnabled ? [styles.stickyCell, styles.stickyHeaderCell, stickyRight(3)] : null,
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.headerLabel, { textAlign: textAlignFor(column.align) }]}
                >
                  {column.label}
                </Text>
              </View>
            ))}
          </View>

          {data.length === 0 ? (
            <View style={styles.emptyRow}>
              <Text style={type.bodyMuted}>{emptyMessage}</Text>
            </View>
          ) : (
            data.map((row, index) => {
              const selected = isRowSelected?.(row, index) ?? false;
              // Hover is tracked in state rather than read from Pressable's
              // style callback because the pinned cells — which are children,
              // not part of that callback — must repaint the same colour.
              const hovered = hoveredIndex === index;
              const background = rowBackground(index, selected, hovered);

              const cells = columns.map((column, columnIndex) => (
                <View
                  key={column.key} role="cell" aria-colindex={columnIndex + 1}
                  style={[
                    styles.cell,
                    cellLayout(column),
                    column.sticky && pinEnabled
                      ? [styles.stickyCell, { backgroundColor: background }, stickyRight(1)]
                      : null,
                  ]}
                >
                  {column.render(row)}
                </View>
              ));

              const base = [
                styles.bodyRow,
                { minHeight: rowMinHeight, backgroundColor: background },
                selected ? styles.bodyRowSelected : null,
              ];

              // A row that does nothing on press stays a plain View: it must
              // not announce itself as a button, and — the practical reason —
              // rows whose cells hold their own inputs and buttons (the Brand
              // Release table) must not nest those inside a pressable parent.
              if (!onRowPress) {
                return (
                  <View role="row" aria-rowindex={index + 2} key={keyExtractor(row, index)} testID={rowTestID?.(row, index)} style={base}>
                    {cells}
                  </View>
                );
              }

              return (
                <Pressable
                  key={keyExtractor(row, index)}
                  testID={rowTestID?.(row, index)}
                  onPress={() => onRowPress(row, index)}
                  // This record is an activation target, not a passive row.
                  // Expose that consistently to screen readers and keyboards.
                  role="button" tabIndex={0}
                  accessibilityRole="button"
                  {...(Platform.OS === "web" ? { onKeyDown: (event: any) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onRowPress(row, index); }
                  }} : {})}
                  accessibilityLabel={rowAccessibilityLabel?.(row, index)}
                  accessibilityHint="Opens details"
                  onHoverIn={() => setHoveredIndex(index)}
                  onHoverOut={() => setHoveredIndex((current) => (current === index ? null : current))}
                  style={({ pressed }: any) => [
                    ...base,
                    pressed ? styles.bodyRowPressed : null,
                    webCursor("pointer"),
                  ]}
                >
                  {cells}
                </Pressable>
              );
            })
          )}
          </ScrollableBody>
        </View>
      </ScrollView>
    </View>
  );
}

// ── Cell content helpers ────────────────────────────────────────────────────
// Every table renders the same handful of cell shapes. Centralising them is
// what keeps typography and truncation identical across the four screens.

/** Primary identifier for a row — truncates rather than wrapping or clipping. */
export function CellTitle({ children }: { children: ReactNode }) {
  return <Text numberOfLines={1} style={styles.cellTitle}>{children}</Text>;
}

/** Title over a dimmer supporting line (series · finish · size, brand · product). */
export function CellStack({ title, subtitle }: { title: ReactNode; subtitle?: ReactNode }) {
  return (
    <View style={styles.stack}>
      <Text numberOfLines={1} style={styles.cellTitle}>{title}</Text>
      {subtitle ? <Text numberOfLines={1} style={styles.cellSub}>{subtitle}</Text> : null}
    </View>
  );
}

export function CellText({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <Text numberOfLines={1} style={muted ? styles.cellTextMuted : styles.cellText}>
      {children}
    </Text>
  );
}

/** Counters and quantities — tabular figures so digits line up column-wise. */
export function CellNumber({ value, dim }: { value: ReactNode; dim?: boolean }) {
  return <Text style={[styles.cellNumber, dim ? styles.cellNumberDim : null]}>{value}</Text>;
}

/** Order numbers, chalan numbers, timestamps — monospaced, never truncated mid-run. */
export function CellMono({ children }: { children: ReactNode }) {
  return <Text numberOfLines={1} style={styles.cellMono}>{children}</Text>;
}

/** The row's affordance, right-aligned at the end of an otherwise passive row. */
export function CellLink({ children }: { children: ReactNode }) {
  return <Text numberOfLines={1} style={styles.cellLink}>{children}</Text>;
}

/** The same affordance where the column has no room for a word. */
export function CellChevron() {
  return <Text style={styles.cellChevron}>›</Text>;
}

export function ProgressCell({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <View style={styles.progressWrap}>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${clamped}%` }]} />
      </View>
      <Text style={styles.progressLabel}>{clamped}%</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  mobileListShell: { width: "100%", minHeight: 120 },
  mobileListContent: { gap: spacing.s12, paddingBottom: spacing.s24 },
  mobileCard: {
    minHeight: 88,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary,
    padding: spacing.lg,
  },
  mobileCardContent: { gap: spacing.s12 },
  mobilePrimary: { minWidth: 0 },
  mobileFields: { flexDirection: "row", flexWrap: "wrap", gap: spacing.s12 },
  mobileField: { gap: spacing.s4, minWidth: 0, width: "47%", flexGrow: 1 },
  mobileLabel: { ...type.overline, fontSize: 10, color: colors.onSurfaceSubtle },
  mobileValue: { minWidth: 0, width: "100%", alignItems: "flex-start" },
  mobileAction: { minHeight: 44, alignItems: "stretch", justifyContent: "center", gap: spacing.s8, paddingTop: spacing.s8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
  mobileEmpty: { paddingVertical: spacing.s40, paddingHorizontal: spacing.lg, alignItems: "center" },
  shell: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary,
    overflow: "hidden",
  },
  // Lets a table narrower than the viewport stretch to fill it, while a wider
  // one still scrolls horizontally.
  hScrollContent: { minWidth: "100%" },
  table: {},

  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    height: 48,
    backgroundColor: colors.surfaceTertiary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerLabel: {
    ...type.overline,
    fontSize: 11,
    letterSpacing: 0.8,
    color: colors.onSurfaceSecondary,
    width: "100%",
  },

  bodyRow: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  bodyRowPressed: { opacity: 0.9 },
  bodyRowSelected: { borderLeftWidth: 2, borderLeftColor: colors.brand },

  // A pinned cell needs an opaque fill and a rule on its leading edge, so the
  // columns sliding underneath it read as passing behind rather than colliding.
  stickyCell: { borderLeftWidth: 1, borderLeftColor: colors.border },
  stickyHeaderCell: { backgroundColor: colors.surfaceTertiary },

  // 16px per side is the table-cell padding the whole module shares; no
  // inter-cell `gap` is used, because a gap has to be replicated identically
  // on the header to keep labels over their data.
  cell: { paddingHorizontal: spacing.lg, paddingVertical: spacing.s8 },

  emptyRow: { paddingVertical: spacing.s40, paddingHorizontal: spacing.lg, alignItems: "center" },

  stack: { gap: 2, width: "100%" },
  cellTitle: { ...type.bodyStrong, width: "100%" },
  cellSub: { ...type.caption, width: "100%" },
  cellText: { ...type.body, width: "100%" },
  cellTextMuted: { ...type.bodyMuted, width: "100%" },
  cellNumber: {
    ...type.body,
    fontVariant: ["tabular-nums"],
    color: colors.onSurface,
    textAlign: "right",
    width: "100%",
  },
  cellNumberDim: { color: colors.onSurfaceMuted },
  cellMono: {
    ...type.bodySm,
    fontFamily: type.mono.fontFamily,
    fontVariant: ["tabular-nums"],
    color: colors.onSurfaceSecondary,
    width: "100%",
  },
  cellLink: { ...type.bodyStrong, color: colors.brand },
  cellChevron: { fontSize: 22, lineHeight: 24, color: colors.onSurfaceSubtle },

  progressWrap: { flexDirection: "row", alignItems: "center", gap: spacing.s12, width: "100%" },
  progressTrack: {
    flex: 1,
    height: 6,
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.pill,
    overflow: "hidden",
  },
  progressFill: { height: "100%", backgroundColor: colors.brand, borderRadius: radius.pill },
  progressLabel: {
    ...type.captionStrong,
    fontVariant: ["tabular-nums"],
    width: 38,
    textAlign: "right",
  },
});
