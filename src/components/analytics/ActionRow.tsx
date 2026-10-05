import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import { Linking, Pressable, View } from "react-native";
import { Text } from "@/src/components/AppText";

import type { ExecutiveRow, RowAction } from "@/src/api/executive";
import { HoverCard } from "@/src/components/ds";
import { fmtMoneyCompact } from "@/src/design/tokens";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

type FeatherName = React.ComponentProps<typeof Feather>["name"];

const ACTION_META: Record<RowAction, { label: string; icon: FeatherName }> = {
  open: { label: "Open", icon: "external-link" },
  open_customer: { label: "Open customer", icon: "user" },
  open_po: { label: "Open PO", icon: "file-text" },
  call: { label: "Call", icon: "phone" },
  whatsapp: { label: "WhatsApp", icon: "message-circle" },
  schedule_followup: { label: "Follow-up", icon: "calendar" },
  assign: { label: "Assign", icon: "user-plus" },
  record_payment: { label: "Record payment", icon: "credit-card" },
  send_reminder: { label: "Remind", icon: "bell" },
};

/** Where each action hands off to. Every one reuses an existing screen or the
 *  existing dialler — spec §14.1: no new write paths are created here. */
function destinationFor(action: RowAction, row: ExecutiveRow): string {
  const { entity } = row;
  switch (action) {
    case "open_customer":
      return entity.customer_id ? `/(admin)/customers/${entity.customer_id}` : row.destination;
    case "open_po":
      return "/(admin)/purchases";
    case "schedule_followup":
    case "assign":
      return "/(admin)/followups";
    case "record_payment":
      return "/(admin)/payments";
    case "send_reminder":
      return "/(admin)/followups";
    default:
      return row.destination;
  }
}

/**
 * One problem or opening, with the money at stake and a way to act on it
 * (spec §14.1).
 *
 * Four rules this component exists to hold:
 *  1. **No nested interactive elements.** The outer container is a HoverCard,
 *     which never sets accessibilityRole="button" on its Pressable — RN-Web
 *     maps role=button to a real <button>, and a button containing buttons is
 *     invalid HTML that produced real hydration errors here on 2026-07-24.
 *  2. **Actions come from the payload only.** The backend already filtered
 *     them by the caller's real role; re-deriving permissions in the frontend
 *     would be a second, drifting source of truth. A missing action is absent,
 *     never rendered disabled.
 *  3. **44px minimum** on every control.
 *  4. Context fields render in payload order, exactly as the rule emitted them.
 */
export function ActionRow({
  row,
  compact,
  testID,
}: {
  row: ExecutiveRow;
  compact?: boolean;
  testID?: string;
}) {
  const router = useRouter();
  const isAttention = row.kind === "attention";
  const accent = isAttention ? colors.error : colors.success;

  const runAction = (action: RowAction) => {
    if (action === "call") {
      const phone = row.entity.phone;
      if (phone) void Linking.openURL(`tel:${phone}`);
      return;
    }
    if (action === "whatsapp") {
      const phone = (row.entity.phone || "").replace(/[^\d]/g, "");
      if (phone) void Linking.openURL(`https://wa.me/${phone}`);
      return;
    }
    router.push(destinationFor(action, row) as never);
  };

  return (
    <HoverCard
      testID={testID}
      onPress={() => router.push(row.destination as never)}
      padding={compact ? spacing.md : spacing.lg}
      radius={radius.md}
    >
      <View style={{ gap: compact ? spacing.xs : spacing.sm }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.md }}>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={type.bodyStrong} numberOfLines={2}>
              {row.headline}
            </Text>
            {row.age_days !== null ? (
              <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>
                {row.age_days} {row.age_days === 1 ? "day" : "days"}
              </Text>
            ) : null}
          </View>
          <Text
            style={[
              type.titleSm,
              { color: accent, fontVariant: ["tabular-nums"], textAlign: "right" },
            ]}
            numberOfLines={1}
          >
            {fmtMoneyCompact(row.impact)}
          </Text>
        </View>

        {!compact && row.context.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
            {row.context.map(([label, value]) => (
              <View key={`${label}-${value}`} style={{ gap: 1, minWidth: 0 }}>
                <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>{label}</Text>
                <Text style={type.caption} numberOfLines={1}>
                  {value}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {row.actions.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: 2 }}>
            {row.actions.map((action) => {
              const meta = ACTION_META[action];
              if (!meta) return null;
              return (
                <Pressable
                  key={action}
                  accessibilityRole="button"
                  accessibilityLabel={`${meta.label} — ${row.headline}`}
                  onPress={() => runAction(action)}
                  testID={testID ? `${testID}-${action}` : undefined}
                  style={{
                    minHeight: 44,
                    minWidth: 44,
                    paddingHorizontal: spacing.md,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: spacing.xs,
                    borderRadius: radius.sm,
                    borderWidth: 1,
                    borderColor: colors.border,
                    backgroundColor: colors.surface,
                  }}
                >
                  <Feather name={meta.icon} size={14} color={colors.onSurfaceSecondary} />
                  <Text style={type.caption}>{meta.label}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>
    </HoverCard>
  );
}
