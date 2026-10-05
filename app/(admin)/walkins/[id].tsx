// Walk-in detail — Phase 4 (2026-07-30). Status transitions, notes, and the
// Customer Timeline (reused via services/activity_log.timeline_for — same
// audit trail every other module already writes to, nothing new to render
// beyond a generic event list).
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Linking, Platform, ScrollView, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { SafeAreaView } from "react-native-safe-area-context";

import { walkinsApi, type WalkIn } from "@/src/api/walkins";
import { toast } from "@/src/components/Toast";
import { useBp } from "@/src/design/responsive";
import { Avatar, Button, Card, ErrorState, ListRow, PageHeader, SearchField, Sheet, Skeleton, TextField } from "@/src/components/ui";
import { colors, spacing, type } from "@/src/theme/tokens";

async function openUrl(url: string) {
  if (Platform.OS === "web") {
    // @ts-ignore — web only
    window.open(url, "_blank");
  } else {
    await Linking.openURL(url);
  }
}

const NEXT_STATUS: Record<string, { value: string; label: string }[]> = {
  new: [{ value: "contacted", label: "Mark Contacted" }],
  contacted: [{ value: "selection_scheduled", label: "Schedule Selection" }],
  selection_scheduled: [{ value: "contacted", label: "Reschedule" }],
};

export default function WalkInDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { isPhone } = useBp();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [w, setW] = useState<WalkIn | null>(null);
  const [timeline, setTimeline] = useState<Record<string, any>[]>([]);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [assignees, setAssignees] = useState<{ id: string; full_name: string; role: string }[]>([]);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [spSearch, setSpSearch] = useState("");

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [detail, tl] = await Promise.all([walkinsApi.get(id), walkinsApi.timeline(id)]);
      setW(detail); setNotes(detail.notes || ""); setTimeline(tl);
    } catch (e: any) {
      setLoadError(e?.detail || "Could not load walk-in. Please retry.");
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { walkinsApi.listAssignees().then(setAssignees).catch(() => {}); }, []);

  const updateStatus = async (status: string) => {
    if (status === "lost" && !notes.trim()) {
      toast.error("Add a note before marking this client as lost");
      return;
    }
    setBusy(true);
    try {
      await walkinsApi.update(id, { status: status as any, ...(status === "lost" ? { notes: notes.trim() } : {}) });
      toast.success("Walk-in updated");
      load();
    } catch (e: any) {
      toast.error(e?.detail || "Could not update Walk-in");
    } finally {
      setBusy(false);
    }
  };

  const saveNotes = async () => {
    setBusy(true);
    try {
      await walkinsApi.update(id, { notes });
      toast.success("Notes saved");
    } catch (e: any) {
      toast.error(e?.detail || "Could not save notes");
    } finally {
      setBusy(false);
    }
  };

  const whatsApp = async () => {
    try {
      const res = await walkinsApi.contact(id, "whatsapp");
      if (res.wa_url) await openUrl(res.wa_url);
    } catch (e: any) {
      toast.error(e?.detail || "Could not open WhatsApp");
    }
  };

  const reassign = async (salespersonId: string) => {
    setBusy(true);
    try {
      await walkinsApi.reassign(id, salespersonId);
      toast.success("Salesperson reassigned");
      setReassignOpen(false); setSpSearch("");
      load();
    } catch (e: any) {
      toast.error(e?.detail || "Could not reassign");
    } finally {
      setBusy(false);
    }
  };

  const filteredAssignees = assignees.filter((a) => a.full_name.toLowerCase().includes(spSearch.trim().toLowerCase()));

  if (!w) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={isPhone ? [] : ["top"]}>
        <PageHeader title="Walk-in" back={() => router.back()} />
        <View style={{ padding: isPhone ? spacing.lg : spacing.xl }}>{loadError ? <ErrorState title="Could not load walk-in" subtitle={loadError} onRetry={() => void load()} /> : <Skeleton h={120} />}</View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={isPhone ? [] : ["top"]}>
      <PageHeader title={w.customer_name} overline={w.number} back={() => router.back()} />
      <ScrollView contentContainerStyle={{ padding: isPhone ? spacing.lg : spacing.xl, paddingBottom: isPhone ? 132 : spacing.xxl, gap: spacing.md }}>
        <Card variant="outlined" style={{ gap: 4 }}>
          <Text style={type.bodyStrong}>{w.customer_phone} {w.alternate_phone ? `· Alt: ${w.alternate_phone}` : ""}</Text>
          <Text style={type.bodyMuted}>{w.source} · {(w.interested_products || []).join(", ") || "No products noted"}</Text>
          {w.budget ? <Text style={type.bodySm}>Budget: ₹{w.budget.toLocaleString("en-IN")}</Text> : null}
          {(w.reference_contact || w.architect || w.builder) ? (
            <Text style={type.bodySm}>
              {[w.reference_contact && `Ref: ${w.reference_contact}`, w.architect && `Architect: ${w.architect}`, w.builder && `Builder: ${w.builder}`].filter(Boolean).join(" · ")}
            </Text>
          ) : null}
          <Text style={[type.captionStrong, { color: colors.brandHover, marginTop: 4 }]}>Status: {w.status.replace(/_/g, " ")}</Text>
        </Card>

        <ListRow
          title={w.salesperson_name || "Unassigned"}
          subtitle="Salesperson"
          leading={<Avatar name={w.salesperson_name || "?"} size={36} />}
          right={<Text style={[type.captionStrong, { color: colors.brandHover }]}>Reassign</Text>}
          onPress={() => setReassignOpen(true)}
          isFirst
          testID="walkin-reassign-row"
        />

        <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
          <Button label="Call" icon="phone" variant="secondary" size="sm" onPress={() => w.customer_phone && openUrl(`tel:${w.customer_phone}`)} />
          <Button label="WhatsApp" icon="message-circle" variant="secondary" size="sm" onPress={whatsApp} />
          {(NEXT_STATUS[w.status] || []).map((s) => (
            <Button key={s.value} label={s.label} variant="secondary" size="sm" loading={busy} onPress={() => updateStatus(s.value)} />
          ))}
          {w.status !== "converted" && w.status !== "lost" ? (
            <Button label="Mark Converted" size="sm" loading={busy} onPress={() => updateStatus("converted")} testID="walkin-mark-converted" />
          ) : null}
          {w.status !== "converted" && w.status !== "lost" ? (
            <Button label="Mark Lost" variant="danger" size="sm" loading={busy} onPress={() => updateStatus("lost")} testID="walkin-mark-lost" />
          ) : null}
        </View>

        <TextField label="Notes" value={notes} onChangeText={setNotes} multiline numberOfLines={3} />
        <Button label="Save Notes" variant="secondary" size="sm" onPress={saveNotes} loading={busy} />

        <Text style={type.bodyStrong}>Customer Timeline</Text>
        {timeline.length === 0 ? (
          <Text style={type.bodyMuted}>No activity yet.</Text>
        ) : (
          timeline.map((ev, i) => (
            <Card key={ev.id || i} variant="outlined" style={{ gap: 2 }}>
              <Text style={type.bodySm}>{ev.summary || ev.event_type}</Text>
              <Text style={type.caption}>{(ev.created_at || "").toString().slice(0, 16).replace("T", " ")}</Text>
            </Card>
          ))
        )}
      </ScrollView>

      <Sheet visible={reassignOpen} onClose={() => setReassignOpen(false)} title="Reassign Salesperson" variant="bottom">
        <View style={{ padding: spacing.lg, gap: spacing.md, flex: 1 }}>
          <SearchField placeholder="Search staff…" value={spSearch} onChangeText={setSpSearch} onClear={() => setSpSearch("")} />
          <ScrollView>
            {filteredAssignees.map((a, i) => (
              <ListRow
                key={a.id} title={a.full_name} subtitle={a.role}
                leading={<Avatar name={a.full_name} size={36} />}
                onPress={() => reassign(a.id)}
                isFirst={i === 0}
                testID={`walkin-reassign-${a.id}`}
              />
            ))}
          </ScrollView>
        </View>
      </Sheet>
    </SafeAreaView>
  );
}
