import { Text, View } from "react-native";

import { Card, EmptyState, ErrorState, LoadingState, SkeletonList } from "@/src/components/ui";
import { useBp } from "@/src/design/responsive";
import { colors, layout, spacing, type } from "@/src/theme/tokens";

/**
 * One block of the Sales Data page: a titled card that owns its own loading,
 * error and empty states.
 *
 * Every section on the page is one of these, so a section that has no data
 * always says so in the same words and in the same place. The alternative —
 * each block inventing its own empty rendering — is how a page ends up
 * showing a blank card in one place and "₹0" in another for the identical
 * condition, leaving the owner unable to tell "nothing sold" from "failed to
 * load".
 *
 * `question` is the owner-facing question the block answers, kept on the
 * block itself rather than in documentation.
 */
export function SalesSection<T>({
  title, question, rows, error, onRetry, emptyTitle, emptySubtitle, footer, testID, children,
}: {
  title: string;
  question?: string;
  /** null means still loading. */
  rows: T[] | null;
  error?: string | null;
  onRetry?: () => void;
  emptyTitle: string;
  emptySubtitle?: string;
  footer?: React.ReactNode;
  testID: string;
  children: (rows: T[]) => React.ReactNode;
}) {
  const { isPhone, isTabletPortrait } = useBp();
  // 24px of interior padding crowds a 375px viewport; the card language's own
  // base/spacious pair is what keeps every card on the page breathing the
  // same way at each width instead of one fixed value at all of them.
  // Tablet portrait shares the admin rail and narrow usable column with
  // phones. The compact padding preserves the card rhythm while leaving room
  // for values and touch targets rather than creating horizontal overflow.
  const padding = isPhone || isTabletPortrait ? layout.cardPadding.base : layout.cardPadding.spacious;

  return (
    <Card testID={testID} variant="flat" padding={padding}>
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: spacing.s4 }}>
          {/* titleMd, not titleSm: at 15px a section heading sat only two
              points above the 13px rows beneath it, which read as emphasis
              rather than as a level in the hierarchy. */}
          <Text style={type.titleMd}>{title}</Text>
          {question ? (
            <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>{question}</Text>
          ) : null}
        </View>

        {error ? (
          <ErrorState subtitle={error} onRetry={onRetry} />
        ) : rows === null ? (
          <SkeletonList rows={4} />
        ) : rows.length === 0 ? (
          <EmptyState icon="inbox" title={emptyTitle} subtitle={emptySubtitle} />
        ) : (
          <>
            {children(rows)}
            {footer}
          </>
        )}
      </View>
    </Card>
  );
}

/** Re-exported so sections that need a spinner rather than skeleton rows do
 *  not reach past this module for it. */
export { LoadingState };
