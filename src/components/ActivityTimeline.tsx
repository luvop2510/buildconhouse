// Activity Timeline — renders a list of ActivityEvent docs in reverse-chrono order.
// The UI is deliberately dense and readable: dot + timestamp + summary.
import Feather from "@expo/vector-icons/Feather";
import { StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { colors, radius, spacing, type } from "@/src/theme/tokens";

export type TimelineEvent = {
  id: string;
  event_type: string;
  entity_type: string;
  actor_name?: string | null;
  summary?: string | null;
  created_at: string;
  payload?: Record<string, any>;
};

// Icon + tone for each canonical event type. Falls back to a neutral dot.
const EVENT_META: Record<string, { icon: keyof typeof import("@expo/vector-icons").Feather.glyphMap; tone: string }> = {
  "quotation.created":            { icon: "file-plus",      tone: colors.info },
  "quotation.product_added":      { icon: "plus-circle",    tone: colors.success },
  "quotation.product_removed":    { icon: "minus-circle",   tone: colors.warning },
  "quotation.product_reordered":  { icon: "move",           tone: colors.onSurfaceMuted },
  "quotation.variant_changed":    { icon: "shuffle",        tone: colors.onSurfaceMuted },
  "quotation.room_created":       { icon: "grid",           tone: colors.info },
  "quotation.room_renamed":       { icon: "edit-3",         tone: colors.onSurfaceMuted },
  "quotation.room_deleted":       { icon: "grid",           tone: colors.error },
  "quotation.discount_changed":   { icon: "percent",        tone: colors.warning },
  "quotation.saved":              { icon: "save",           tone: colors.onSurfaceMuted },
  "quotation.revision_created":   { icon: "git-branch",     tone: colors.info },
  "quotation.pdf_generated":      { icon: "download",       tone: colors.info },
  "quotation.status_changed":     { icon: "activity",       tone: colors.info },
  "quotation.order_placed":       { icon: "check-circle",   tone: colors.success },
  "quotation.duplicated":         { icon: "copy",           tone: colors.onSurfaceMuted },
  "purchase.created":             { icon: "shopping-cart",  tone: colors.info },
  "purchase.status_changed":      { icon: "activity",       tone: colors.info },
  "purchase.received":            { icon: "package",        tone: colors.success },
  "purchase.note_updated":        { icon: "edit",           tone: colors.onSurfaceMuted },
  "purchase.attachment_added":    { icon: "paperclip",      tone: colors.onSurfaceMuted },
  "purchase.assigned":            { icon: "user-check",     tone: colors.info },
  "purchase.supplier_changed":    { icon: "truck",          tone: colors.info },
  "purchase.items_updated":       { icon: "list",           tone: colors.onSurfaceMuted },
  "purchase.dispatched":          { icon: "send",           tone: colors.success },
  "customer.created":             { icon: "user-plus",      tone: colors.info },
  "customer.updated":             { icon: "edit-2",         tone: colors.onSurfaceMuted },
  "followup.created":             { icon: "flag",           tone: colors.info },
  "followup.contacted":           { icon: "send",           tone: colors.info },
  "followup.call_logged":         { icon: "phone",          tone: colors.success },
  "followup.completed":           { icon: "check-circle",   tone: colors.success },
  "followup.snoozed":             { icon: "clock",          tone: colors.warning },
  "followup.assigned":            { icon: "user-check",     tone: colors.info },
  "followup.dismissed":           { icon: "x-circle",       tone: colors.onSurfaceMuted },
  "followup.note_added":          { icon: "edit-3",         tone: colors.onSurfaceMuted },
  "followup.auto_resolved":       { icon: "zap",            tone: colors.onSurfaceMuted },
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  const y = new Date(now.getTime() - 86400000);
  const yesterday = d.toDateString() === y.toDateString();
  const time = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  if (same) return `Today · ${time}`;
  if (yesterday) return `Yesterday · ${time}`;
  return `${d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })} · ${time}`;
}

function titleize(eventType: string): string {
  return eventType.split(".").pop()!.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ActivityTimeline({
  events,
  emptyLabel = "No activity yet",
  dense = false,
}: {
  events: TimelineEvent[];
  emptyLabel?: string;
  dense?: boolean;
}) {
  if (!events || events.length === 0) {
    return (
      <View style={{ padding: spacing.xl, alignItems: "center", opacity: 0.7 }}>
        <Feather name="clock" size={20} color={colors.onSurfaceMuted} />
        <Text style={[type.caption, { marginTop: 6 }]}>{emptyLabel}</Text>
      </View>
    );
  }
  return (
    <View style={{ gap: dense ? 2 : 4 }}>
      {events.map((e, idx) => {
        const meta = EVENT_META[e.event_type] || { icon: "circle" as const, tone: colors.onSurfaceMuted };
        const isLast = idx === events.length - 1;
        return (
          <View key={e.id} style={{ flexDirection: "row", gap: spacing.md, paddingLeft: 4 }}>
            <View style={{ alignItems: "center", width: 24 }}>
              <View style={[styles.dot, { backgroundColor: meta.tone + "22", borderColor: meta.tone }]}>
                <Feather name={meta.icon} size={11} color={meta.tone} />
              </View>
              {!isLast ? <View style={styles.line} /> : null}
            </View>
            <View style={{ flex: 1, paddingBottom: isLast ? 0 : dense ? spacing.sm : spacing.md }}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: colors.onSurface }}>
                {e.summary || titleize(e.event_type)}
              </Text>
              <Text style={[type.caption, { marginTop: 2 }]}>
                {e.actor_name || "System"} · {fmtTime(e.created_at)}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {
    width: 22, height: 22, borderRadius: radius.pill,
    borderWidth: 1.5, alignItems: "center", justifyContent: "center",
  },
  line: { width: 1.5, flex: 1, backgroundColor: colors.border, marginTop: 2 },
});
