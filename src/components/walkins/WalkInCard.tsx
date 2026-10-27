// Walk-in card — Phase 4 (2026-07-30). Same visual language as
// components/tiles cards: Card + IconButton + Button.
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";

import type { WalkIn } from "@/src/api/walkins";
import { toast } from "@/src/components/Toast";
import { Button, Card, IconButton } from "@/src/components/ui";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

const STATUS_LABEL: Record<WalkIn["status"], string> = {
  new: "New", contacted: "Contacted", selection_scheduled: "Selection Scheduled",
  selection_completed: "Selection Completed", quotation_created: "Quotation Created",
  converted: "Converted", lost: "Lost",
};
const STATUS_TONE: Record<WalkIn["status"], { bg: string; fg: string }> = {
  new: { bg: colors.brandTint, fg: colors.brandHover },
  contacted: { bg: colors.surfaceTertiary, fg: colors.onSurfaceSecondary },
  selection_scheduled: { bg: colors.warningBg, fg: colors.warning },
  selection_completed: { bg: colors.warningBg, fg: colors.warning },
  quotation_created: { bg: colors.warningBg, fg: colors.warning },
  converted: { bg: colors.successBg, fg: colors.success },
  lost: { bg: colors.surfaceTertiary, fg: colors.error },
};

function daysWaiting(visitedAt: string): number {
  const diff = Date.now() - new Date(visitedAt).getTime();
  return Math.max(0, Math.floor(diff / 86400000));
}

export function WalkInCard({
  w, onPress, onCall, onWhatsApp, onScheduleSelection, quotationFollowup = false, onSaveQuotationPrice, onTransferToQuotation, onVisitShowroom,
}: {
  w: WalkIn; onPress: () => void; onCall: () => void; onWhatsApp?: () => void; onScheduleSelection?: () => void;
  quotationFollowup?: boolean;
  onSaveQuotationPrice?: (price: number | null) => Promise<void>;
  onTransferToQuotation?: () => void;
  onVisitShowroom?: () => Promise<void>;
}) {
  const tone = STATUS_TONE[w.status] || STATUS_TONE.new;
  const days = daysWaiting(w.visited_at);
  const [price, setPrice] = useState(w.quotation_price?.toString() || "");
  const [transferring, setTransferring] = useState(false);
  const [savingPrice, setSavingPrice] = useState(false);

  useEffect(() => { setPrice(w.quotation_price?.toString() || ""); }, [w.quotation_price]);

  const savePrice = async () => {
    const trimmed = price.trim();
    const value = trimmed ? Number(trimmed) : null;
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      toast.error("Enter a valid non-negative price");
      return;
    }
    if (!onSaveQuotationPrice) return;
    setSavingPrice(true);
    try { await onSaveQuotationPrice(value); } catch { /* The owning page displays the save error. */ } finally { setSavingPrice(false); }
  };
  return (
    <Pressable onPress={onPress} testID={`walkin-card-${w.id}`}>
      <Card variant="outlined" padding={spacing.lg} style={{ marginBottom: spacing.md, gap: spacing.md }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: spacing.sm }}>
          <View style={{ flex: 1, gap: spacing.xs, minWidth: 0 }}>
            <Text style={type.bodyStrong}>{w.customer_name}</Text>
            <Text style={type.bodyMuted}>{w.customer_phone || "No phone"} · {w.number}</Text>
          </View>
          <View style={{ backgroundColor: tone.bg, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 3 }}>
            <Text style={[type.captionStrong, { color: tone.fg }]}>{STATUS_LABEL[w.status] || "New"}</Text>
          </View>
        </View>
        <Text style={type.bodySm}>
          {w.source} · {(w.interested_products || []).join(", ") || "No products noted"}
        </Text>
        <View style={{ flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", gap: spacing.sm }}>
          <Text style={type.caption}>{w.salesperson_name || "Unassigned"} · Waiting {days}d</Text>
          {w.budget ? <Text style={type.captionStrong}>Budget ₹{w.budget.toLocaleString("en-IN")}</Text> : null}
        </View>
        {quotationFollowup ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.xs }}>
            <Text style={[type.captionStrong, { minWidth: 42 }]}>Price ₹</Text>
            <TextInput
              value={price}
              onChangeText={setPrice}
              placeholder="Enter price"
              keyboardType="decimal-pad"
              accessibilityLabel={`Quotation price for ${w.customer_name}`}
              style={{ flex: 1, minHeight: 38, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: spacing.sm, color: colors.onSurface }}
            />
            <Button label="Save" variant="secondary" size="sm" loading={savingPrice} onPress={() => { void savePrice(); }} testID={`walkin-price-save-${w.id}`} />
          </View>
        ) : null}
        <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs, flexWrap: "wrap" }}>
          <IconButton icon="phone" onPress={onCall} size={44} tone="brandLight" accessibilityLabel="Call" testID={`walkin-call-${w.id}`} />
          {onWhatsApp ? <IconButton icon="message-circle" onPress={onWhatsApp} size={44} tone="surface" accessibilityLabel="WhatsApp" testID={`walkin-wa-${w.id}`} /> : null}
          {onVisitShowroom && !w.showroom_followup_id && !w.showroom_transferred_at && w.status !== "lost" ? (
            <Button label={w.showroom_followup_id ? "View Visit Showroom" : "Visit Showroom"} icon="home" size="sm" loading={transferring} onPress={() => {
              if (transferring) return;
              setTransferring(true);
              void onVisitShowroom().finally(() => setTransferring(false));
            }} testID={`walkin-visit-showroom-${w.id}`} />
          ) : null}
          {w.floor_id === "ground-floor" && onScheduleSelection && w.status !== "lost" && w.status !== "converted" && w.status !== "quotation_created" ? (
            <Button label="Schedule Selection" icon="calendar" variant="secondary" size="sm" onPress={onScheduleSelection} testID={`walkin-schedule-${w.id}`} />
          ) : null}
          {onTransferToQuotation && w.status !== "lost" && w.status !== "converted" ? (
            <Button label="Transfer to Quotation Follow-up" icon="arrow-right" size="sm" onPress={onTransferToQuotation} testID={`walkin-transfer-quotation-${w.id}`} />
          ) : null}
        </View>
      </Card>
    </Pressable>
  );
}
