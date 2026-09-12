import { Disclosure } from "@/src/design/Disclosure";
// Walk-ins — Phase 4 (2026-07-30). Company-wide CRM entry point:
// Walk-in -> Customer -> Selection -> Quotation -> Order -> Dispatch -> Payment.
// Dedicated workspace: KPI dashboard + filterable list, matching the same
// premium design language as Follow-ups / Tile Orders (Card/Chip/StatTile).
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Platform, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { walkinsApi, type WalkIn, type WalkInsDashboard } from "@/src/api/walkins";
import { toast } from "@/src/components/Toast";
import { Button, Chip, EmptyState, ErrorState, LoadingState, PageHeader, SearchField, StatTile } from "@/src/components/ui";
import { WalkInCard } from "@/src/components/walkins/WalkInCard";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { useBp } from "@/src/design/responsive";
import { spacing, type } from "@/src/theme/tokens";

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All" }, { value: "new", label: "New" }, { value: "contacted", label: "Contacted" },
  { value: "selection_scheduled", label: "Selection Scheduled" }, { value: "converted", label: "Converted" },
  { value: "lost", label: "Lost" },
];
const WALKIN_RENDER_BATCH = 40;

async function openUrl(url: string) {
  if (Platform.OS === "web") {
    // @ts-ignore — web only
    window.open(url, "_blank");
  } else {
    await Linking.openURL(url);
  }
}

export default function WalkInsScreen({
  fixedFloorId, title = "Walk-ins", quotationFollowup = false, enableQuotationTransfer = false,
}: { fixedFloorId?: string; title?: string; quotationFollowup?: boolean; enableQuotationTransfer?: boolean } = {}) {
  const router = useRouter();
  const { isPhone } = useBp();
  const { floors } = useFloorAccess();
  const [summaryError, setSummaryError] = useState(false);
  const [dashboard, setDashboard] = useState<WalkInsDashboard | null>(null);
  const [items, setItems] = useState<WalkIn[]>([]);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(WALKIN_RENDER_BATCH);
  const [floorId, setFloorId] = useState(fixedFloorId || "");
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestId = useRef(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const request = ++requestId.current;
    setLoadError(null);
    setLoading(true);
    try {
      const [dash, list] = await Promise.allSettled([
        walkinsApi.dashboard(fixedFloorId ? { floorId: fixedFloorId } : undefined),
        walkinsApi.list({ status: quotationFollowup ? "converted" : status || undefined, floor_id: floorId || undefined, search: search || undefined }, fixedFloorId ? { floorId: fixedFloorId } : undefined),
      ]);
      if (request !== requestId.current) return;
      setSummaryError(dash.status === 'rejected');
      setDashboard(dash.status === 'fulfilled' ? dash.value : null);
      if (list.status === 'fulfilled') setItems(list.value);
      else throw list.reason;
    } catch (e: any) {
      if (request === requestId.current) setLoadError(e?.detail || "Could not load walk-ins");
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, [fixedFloorId, quotationFollowup, status, floorId, search]);

  useEffect(() => { load(); return () => { requestId.current += 1; }; }, [load]);
  useEffect(() => { setVisibleCount(WALKIN_RENDER_BATCH); }, [status, search, floorId, quotationFollowup]);

  const callCustomer = (w: WalkIn) => {
    if (!w.customer_phone) { toast.error("No phone number on file"); return; }
    openUrl(`tel:${w.customer_phone}`);
  };
  const whatsAppCustomer = async (w: WalkIn) => {
    try {
      const res = await walkinsApi.contact(w.id, "whatsapp", fixedFloorId ? { floorId: fixedFloorId } : undefined);
      if (res.wa_url) await openUrl(res.wa_url);
      toast.success("WhatsApp opened");
    } catch (e: any) {
      toast.error(e?.detail || "Could not open WhatsApp");
    }
  };
  const scheduleSelection = async (w: WalkIn) => {
    try {
      await walkinsApi.update(w.id, { status: "selection_scheduled" }, fixedFloorId ? { floorId: fixedFloorId } : undefined);
      toast.success("Marked as Selection Scheduled");
      load();
    } catch (e: any) {
      toast.error(e?.detail || "Could not update status");
    }
  };
  const saveQuotationPrice = async (w: WalkIn, quotationPrice: number | null) => {
    try {
      await walkinsApi.update(w.id, { quotation_price: quotationPrice }, fixedFloorId ? { floorId: fixedFloorId } : undefined);
      setItems((current) => current.map((item) => item.id === w.id ? { ...item, quotation_price: quotationPrice } : item));
      toast.success("Price saved");
    } catch (e: any) {
      toast.error(e?.detail || "Could not save price");
      throw e;
    }
  };
  const transferToQuotationFollowup = async (w: WalkIn) => {
    try {
      await walkinsApi.update(w.id, { status: "converted" }, fixedFloorId ? { floorId: fixedFloorId } : undefined);
      setItems((current) => current.filter((item) => item.id !== w.id));
      toast.success("Transferred to Quotation Follow-up");
    } catch (e: any) {
      toast.error(e?.detail || "Could not transfer customer");
    }
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={isPhone ? [] : ["top"]}>
      <PageHeader
        title={title} overline={quotationFollowup ? "QUOTATION FOLLOW-UP" : "CRM"}
        subtitle="Every customer journey starts here"
        actions={<Button label="Log Walk-in" icon="user-plus" onPress={() => router.push((fixedFloorId ? `/(admin)/walkins/new?floor_id=${fixedFloorId}` : "/(admin)/walkins/new") as any)} testID="walkin-new-btn" />}
      />
      <ScrollView contentContainerStyle={{ padding: isPhone ? spacing.lg : spacing.xl, paddingBottom: isPhone ? 132 : spacing.xxxl }}>
        <Disclosure title="Walk-in summary">
        {summaryError ? <Text role="status" style={[type.bodyMuted, { marginBottom: spacing.sm }]}>Summary unavailable. Your walk-in register is still available below.</Text> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.lg }}>
          <StatTile label="Today" value={dashboard?.today_walkins ?? "—"} icon="user-plus" tone="brand" style={{ minWidth: isPhone ? 120 : 140, flex: 1 }} />
          <StatTile label="This Week" value={dashboard?.this_week ?? "—"} icon="calendar" style={{ minWidth: isPhone ? 120 : 140, flex: 1 }} />
          <StatTile label="Pending Follow-ups" value={dashboard?.pending_followups ?? "—"} icon="clock" tone="warning" style={{ minWidth: isPhone ? 120 : 140, flex: 1 }} />
          <StatTile label="Selections Scheduled" value={dashboard?.selections_scheduled ?? "—"} icon="calendar" style={{ minWidth: isPhone ? 120 : 140, flex: 1 }} />
          <StatTile label="Converted" value={dashboard?.converted ?? "—"} icon="check-circle" tone="success" style={{ minWidth: isPhone ? 120 : 140, flex: 1 }} />
          <StatTile label="Lost" value={dashboard?.lost ?? "—"} icon="x-circle" tone="danger" style={{ minWidth: isPhone ? 120 : 140, flex: 1 }} />
          <StatTile label="Conversion Rate" value={dashboard ? `${dashboard.conversion_rate}%` : "—"} icon="trending-up" tone="brand" style={{ minWidth: isPhone ? 120 : 140, flex: 1 }} />
          <StatTile label="Avg. Conversion" value={dashboard ? `${dashboard.avg_conversion_days}d` : "—"} icon="activity" style={{ minWidth: isPhone ? 120 : 140, flex: 1 }} />
        </View>

        </Disclosure>
        <SearchField
          placeholder="Search customer, phone, salesperson, source, notes…"
          value={search} onChangeText={setSearch} onClear={() => setSearch("")}
          style={{ marginBottom: spacing.md }}
        />
        <View style={{ flexDirection: "row", gap: spacing.xs, flexWrap: "wrap", marginBottom: spacing.sm }}>
          {!quotationFollowup && STATUS_FILTERS.map((s) => (
            <Chip key={s.value} label={s.label} active={status === s.value} onPress={() => setStatus(s.value)} />
          ))}
        </View>
        {floors.length > 1 && !fixedFloorId ? (
          <View style={{ flexDirection: "row", gap: spacing.xs, flexWrap: "wrap", marginBottom: spacing.lg }}>
            <Chip label="All departments" active={floorId === ""} onPress={() => setFloorId("")} />
            {floors.map((f) => (
              <Chip key={f.id} label={f.name} active={floorId === f.id} onPress={() => setFloorId(f.id)} />
            ))}
          </View>
        ) : null}

        {loadError ? <ErrorState title="Could not load walk-ins" subtitle={loadError} onRetry={() => void load()} /> : loading ? <LoadingState label="Loading walk-ins…" /> : items.length === 0 ? (
          <EmptyState icon="user-plus" title="No walk-ins yet" subtitle="Log your first walk-in to start the pipeline." />
        ) : (
          <>
          {items.slice(0, visibleCount).map((w) => (
            <WalkInCard
              key={w.id} w={w}
              onPress={() => router.push(`/(admin)/walkins/${w.id}` as any)}
              onCall={() => callCustomer(w)}
              onWhatsApp={() => whatsAppCustomer(w)}
              onScheduleSelection={() => scheduleSelection(w)}
              quotationFollowup={quotationFollowup}
              onSaveQuotationPrice={quotationFollowup ? (price) => saveQuotationPrice(w, price) : undefined}
              onTransferToQuotation={enableQuotationTransfer ? () => { void transferToQuotationFollowup(w); } : undefined}
            />
          ))}
          {items.length > visibleCount ? (
            <Button
              label={`Show more (${items.length - visibleCount} remaining)`}
              variant="secondary"
              onPress={() => setVisibleCount((count) => count + WALKIN_RENDER_BATCH)}
              testID="walkins-show-more"
            />
          ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
