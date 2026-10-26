// Walk-in detail — Phase 4 (2026-07-30). Status transitions, notes, and the
// Customer Timeline (reused via services/activity_log.timeline_for — same
// audit trail every other module already writes to, nothing new to render
// beyond a generic event list).
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Platform, ScrollView, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { SafeAreaView } from "react-native-safe-area-context";

import { LeadScopeSheet } from "@/src/components/leads/LeadScopeSheet";
import { walkinsApi, type WalkIn } from "@/src/api/walkins";
import { setSelectedFloorId } from "@/src/hooks/use-floor-access";
import { toast } from "@/src/components/Toast";
import { useAuth } from "@/src/state/auth";
import { hasGrantAccess } from "@/src/team-delegation";
import { useModuleAccess } from "@/src/hooks/use-permissions";
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
  const { id, floor_id } = useLocalSearchParams<{ id: string; floor_id?: string }>();
  const requestOptions = floor_id ? { floorId: floor_id } : undefined;
  const router = useRouter();
  const { isPhone } = useBp();
  const hasModuleAccess = useModuleAccess();
  const { staff } = useAuth();
  const requestId = useRef(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [w, setW] = useState<WalkIn | null>(null);
  const [timeline, setTimeline] = useState<Record<string, any>[]>([]);
  const [notes, setNotes] = useState("");
  const [lostOpen, setLostOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [assignees, setAssignees] = useState<{ id: string; full_name: string; role: string }[]>([]);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [spSearch, setSpSearch] = useState("");

  const load = useCallback(async () => {
    const request = ++requestId.current;
    setLoadError(null);
    try {
      const [detail, tl] = await Promise.all([walkinsApi.get(id, floor_id ? { floorId: floor_id } : undefined), walkinsApi.timeline(id, floor_id ? { floorId: floor_id } : undefined)]);
      if (request !== requestId.current) return;
      setW(detail); setTimeline(tl);
    } catch (e: any) {
      if (request !== requestId.current) return;
      setLoadError(e?.detail || "Could not load walk-in. Please retry.");
    }
  }, [id, floor_id]);

  useEffect(() => { setW(null); void load(); return () => { requestId.current += 1; }; }, [load]);
  useEffect(() => {
    let active = true;
    walkinsApi.listAssignees(floor_id ? { floorId: floor_id } : undefined).then(rows => { if (active) setAssignees(rows); }).catch(() => {});
    return () => { active = false; };
  }, [floor_id]);

  const updateStatus = async (status: string) => {
    if (status === "lost" && !notes.trim()) {
      toast.error("Add a note before marking this client as lost");
      return;
    }
    setBusy(true);
    try {
      await walkinsApi.update(id, { status: status as any, ...(status === "lost" ? { notes: notes.trim() } : {}) }, requestOptions);
      setLostOpen(false);
      toast.success("Walk-in updated");
      load();
    } catch (e: any) {
      toast.error(e?.detail || "Could not update Walk-in");
    } finally {
      setBusy(false);
    }
  };

  const visitShowroom = async () => {
    setBusy(true);
    try {
      const targetFloor = w?.floor_id || floor_id;
      const transfer = await walkinsApi.visitShowroom(id, targetFloor ? { floorId: targetFloor } : requestOptions);
      toast.success("Transferred to Visit Showroom follow-ups");
      if (!hasModuleAccess("followups")) { void load(); return; }
      if (targetFloor) void setSelectedFloorId(targetFloor).catch(() => {});
      router.push(`/(admin)/followups?workspace=visit_showroom&showroom_followup=${encodeURIComponent(transfer.followup_id)}` as any);
    } catch (e: any) { toast.error(e?.detail || "Could not transfer to follow-ups"); }
    finally { setBusy(false); }
  };

  const whatsApp = async () => {
    try {
      const res = await walkinsApi.contact(id, "whatsapp", requestOptions);
      if (res.wa_url) await openUrl(res.wa_url);
    } catch (e: any) {
      toast.error(e?.detail || "Could not open WhatsApp");
    }
  };

  const reassign = async (salespersonId: string) => {
    setBusy(true);
    try {
      await walkinsApi.reassign(id, salespersonId, requestOptions);
      toast.success("Salesperson reassigned");
      setReassignOpen(false); setSpSearch("");
      load();
    } catch (e: any) {
      toast.error(e?.detail || "Could not reassign");
    } finally {
      setBusy(false);
    }
  };

  const canUpdate = !w?.showroom_followup_id && !w?.showroom_transferred_at && (!staff?.custom_access || hasGrantAccess(staff.access_grants, w?.floor_id || floor_id || "", "walkins", "update"));

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
      <ScrollView contentContainerStyle={{ padding: isPhone ? spacing.lg : spacing.xl, paddingBottom: isPhone ? 132 : spacing.xxl, gap: spacing.md }}>
        <PageHeader title={w.customer_name} overline={w.number} back={() => router.back()} embedded />
        <Card variant="outlined" style={{ gap: 4 }}>
          <Text style={type.bodyStrong}>{w.customer_phone} {w.alternate_phone ? `· Alt: ${w.alternate_phone}` : ""}</Text>
          {canUpdate ? <Button label="Interested floors · Assign team" icon="layers" variant="secondary" onPress={() => setScopeOpen(true)} testID="walkin-edit-interests" /> : null}
          {w.referrer_name ? <Text style={type.bodySm}>Interior / architect: {w.referrer_name}</Text> : null}
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
          right={<Text style={[type.captionStrong, { color: colors.brandHover }]}>{canUpdate ? "Reassign" : "Assigned"}</Text>}
          onPress={canUpdate ? () => w.floor_id === "first-floor" ? setScopeOpen(true) : setReassignOpen(true) : undefined}
          isFirst
          testID="walkin-reassign-row"
        />

        <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
          <Button label="Call" icon="phone" variant="secondary" size="sm" onPress={() => w.customer_phone && openUrl(`tel:${w.customer_phone}`)} />
          {canUpdate && !w.showroom_followup_id && !w.showroom_transferred_at && w.status !== "lost" ? <Button label={w.showroom_followup_id ? "View Visit Showroom" : "Visit Showroom"} icon="home" size="sm" loading={busy} onPress={visitShowroom} testID="walkin-visit-showroom" /> : null}
          {canUpdate ? <Button label="WhatsApp" icon="message-circle" variant="secondary" size="sm" onPress={whatsApp} /> : null}
          {(w.floor_id !== "first-floor" && canUpdate ? NEXT_STATUS[w.status] || [] : []).map(s => (
            <Button key={s.value} label={s.label} variant="secondary" size="sm" loading={busy} onPress={() => updateStatus(s.value)} />
          ))}
          {w.floor_id !== "first-floor" && canUpdate && w.status !== "converted" && w.status !== "lost" ? (
            <Button label="Mark Converted" size="sm" loading={busy} onPress={() => updateStatus("converted")} testID="walkin-mark-converted" />
          ) : null}
          {canUpdate && w.status !== "converted" && w.status !== "lost" ? (
            <Button label="Mark Lost" variant="danger" size="sm" loading={busy} onPress={() => { setNotes(""); setLostOpen(true); }} testID="walkin-mark-lost" />
          ) : null}
        </View>

        {w.notes ? <Card variant="outlined"><Text style={type.label}>{w.status === "lost" ? "Lost reason" : "Previous note"}</Text><Text style={type.bodySm}>{w.notes}</Text></Card> : null}

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

      <LeadScopeSheet lead={scopeOpen ? w : null} floorId={w.floor_id} onClose={() => setScopeOpen(false)} onSaved={() => void load()} saveScope={value => walkinsApi.update(id, value, requestOptions)} />
      <Sheet visible={lostOpen} onClose={() => setLostOpen(false)} title="Mark as lost" variant="bottom">
        <View style={{ padding: spacing.lg, gap: spacing.md }}>
          <TextField label="Lost reason" value={notes} onChangeText={setNotes} multiline numberOfLines={3} placeholder="Cannot afford the service, or we cannot work with this customer" testID="walkin-lost-reason" />
          <Button label="Mark as lost" variant="danger" disabled={!notes.trim()} onPress={() => void updateStatus("lost")} loading={busy} testID="walkin-confirm-lost" />
        </View>
      </Sheet>
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
