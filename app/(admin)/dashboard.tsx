// ─────────────────────────────────────────────────────────────────────────────
// Today — the workday home.
// Answers one question: "What is the single most important thing right now?"
// A ranked queue (powered by the follow-up engine), the business in one quiet
// column, and nothing else.
// ─────────────────────────────────────────────────────────────────────────────
import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";

import { api } from "@/src/api/client";
import { toast } from "@/src/components/Toast";
import { Alert, ErrorState } from "@/src/components/ui";
import {
  Button, FadeIn, Hairline, IconButton, Money, Section, Skeleton, StatusWord, Txt,
} from "@/src/design/components";
import { NavigationLink } from "@/src/design/NavigationLink";
import { useBp } from "@/src/design/responsive";
import { color, layout, space } from "@/src/design/tokens";
import { useAuth } from "@/src/state/auth";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { useFloorAccess } from "@/src/hooks/use-floor-access";

type Mission = {
  due_count: number; revenue_at_risk: number; revenue_at_risk_short: string;
  overdue_payments: number; quotations_expiring_today: number; critical_count: number;
  estimated_minutes: number; greeting_name: string;
};
type Fu = {
  id: string; customer_name: string; reason: string; next_action?: string | null;
  value?: number | null; priority_level: string; status: string;
  suggested_channel?: string | null; customer_phone?: string | null;
};
type DashStats = { revenue_month: number; open_pipeline: number; pending_approval: number; quotes_this_month: number };
type PayStats = { total_outstanding: number; collected_this_month: number; active_orders: number; fully_paid: number };
type RecentQ = { id: string; number: string; customer_name: string; grand_total: number; status: string; updated_at: string };
type Shortage = { id: string; customer_id: string; customer_name: string; name: string; shortage_qty: number };

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

const todayLabel = () => new Intl.DateTimeFormat("en-IN", {
  weekday: "long", day: "numeric", month: "long",
}).format(new Date());

// ── Queue row — hover reveals actions on desktop; touch gets the suggested
// channel + done, always visible. One contextual action, not an icon pile.
function QueueRow({
  fu, rank, alwaysShow, canUpdate, onDone, onCall, onWhatsApp, onOpen,
}: {
  fu: Fu; rank: number; alwaysShow: boolean; canUpdate: boolean;
  onDone: () => void; onCall: () => void; onWhatsApp: () => void; onOpen: () => void;
}) {
  const [hover, setHover] = useState(false);
  const preferCall = (fu.suggested_channel || "").toLowerCase() === "call";
  return (
    <Pressable
      onPress={onOpen}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      accessibilityLabel={`${fu.customer_name}, ${fu.next_action || fu.reason}`}
      style={[
        {
          flexDirection: "row", alignItems: "center", gap: space.x3,
          paddingVertical: 14, minHeight: 60,
          marginHorizontal: -space.x3, paddingHorizontal: space.x3, borderRadius: 10,
          backgroundColor: hover ? color.hoverWash : "transparent",
        },
        Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
      ]}
    >
      <Txt v="num" style={{ width: 18, textAlign: "center" }}>{rank}</Txt>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Txt v="rowTitle" numberOfLines={1}>{fu.customer_name}</Txt>
        <Txt v="sub" numberOfLines={1}>{fu.next_action || fu.reason}</Txt>
      </View>
      {fu.value ? <Money value={fu.value} size="sm" tone="mid" compact /> : null}
      {!canUpdate ? null : alwaysShow ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
          <IconButton
            icon={preferCall ? "phone" : "message-circle"}
            size={34} iconSize={16}
            onPress={preferCall ? onCall : onWhatsApp}
            label={preferCall ? "Call" : "WhatsApp"}
          />
          <IconButton icon="check" size={34} iconSize={17} tone="ink" onPress={onDone} label="Mark done" />
        </View>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 2, opacity: hover ? 1 : 0 }}>
          <IconButton icon="phone" size={32} iconSize={15} onPress={onCall} label="Call" />
          <IconButton icon="message-circle" size={32} iconSize={15} onPress={onWhatsApp} label="WhatsApp" />
          <IconButton icon="check" size={32} iconSize={16} tone="ink" onPress={onDone} label="Mark done" />
        </View>
      )}
    </Pressable>
  );
}

// ── A business stat — label, number, whisper. Never a tile. ─────────────────
function Stat({ label, value, note, noteTone = "soft", compactValue }: {
  label: string; value?: number | null; note?: string; noteTone?: "soft" | "risk" | "ok"; compactValue?: boolean;
}) {
  return (
    <View style={{ gap: 3 }}>
      <Txt v="caption" tone="soft">{label}</Txt>
      {value == null ? <Txt v="heading" tone="soft">Unavailable</Txt> : <Money value={value} size="lg" compact={compactValue} />}
      {note ? <Txt v="caption" tone={noteTone === "risk" ? "risk" : noteTone === "ok" ? "ok" : "soft"}>{note}</Txt> : null}
    </View>
  );
}

export default function Today() {
  const router = useRouter();
  const { staff } = useAuth();
  const { selectedFloorId } = useFloorAccess();
  const { isPhone, isDesktop, gutter } = useBp();
  const canFollowups = useActionAccess("followups", "view");
  const canUpdateFollowups = useActionAccess("followups", "update");
  const canQuotations = useActionAccess("quotations", "view");
  const canPayments = useActionAccess("payments", "view");
  const canPurchases = useActionAccess("purchases", "view");

  const [mission, setMission] = useState<Mission | null>(null);
  const [queue, setQueue] = useState<Fu[] | null>(null);
  const [stats, setStats] = useState<DashStats | null>(null);
  const [pay, setPay] = useState<PayStats | null>(null);
  const [recent, setRecent] = useState<RecentQ[] | null>(null);
  const [shortages, setShortages] = useState<Shortage[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [sectionErrors, setSectionErrors] = useState({ queue: false, recent: false });
  const requestVersion = useRef(0);

  const load = useCallback(async (isRefresh = false) => {
    if (!selectedFloorId) return;
    const version = ++requestVersion.current;
    setLoadError(false);
    setSectionErrors({ queue: false, recent: false });
    if (!isRefresh) {
      setMission(null); setQueue(canFollowups ? null : []); setStats(null); setPay(null); setRecent(canQuotations ? null : []); setShortages([]);
    }
    if (isRefresh) setRefreshing(true);
    // Publish each section as soon as its own request finishes. A slow
    // purchases/payments request must not keep the follow-up queue loading.
    const current = () => version === requestVersion.current;
    const section = async <T,>(path: string, publish: (value: T) => void, onError?: () => void) => {
      try {
        const value = await api.get<T>(path, { cacheMs: isRefresh ? 0 : 15_000, floorId: selectedFloorId });
        if (current()) publish(value);
      } catch {
        if (current()) { setLoadError(true); onError?.(); }
      }
    };
    await Promise.all([
      canFollowups && section<Mission>("/followups/mission", setMission),
      canFollowups && section<Fu[]>("/followups?limit=12", value => setQueue((Array.isArray(value) ? value : []).filter(f => f.status === "open").slice(0, 6)), () => {
        setSectionErrors(errors => ({ ...errors, queue: true }));
        if (!isRefresh) setQueue([]);
      }),
      section<DashStats>("/dashboard/stats", setStats),
      canPayments && section<PayStats>("/payments/stats", setPay),
      canQuotations && section<RecentQ[]>("/quotations/recent?limit=5", setRecent, () => {
        setSectionErrors(errors => ({ ...errors, recent: true }));
        if (!isRefresh) setRecent([]);
      }),
      canPurchases && section<{ items: Shortage[] }>("/purchases/shortages?status=awaiting_reorder", value => setShortages(value.items || [])),
    ]);
    if (current()) setRefreshing(false);
  }, [selectedFloorId, canFollowups, canQuotations, canPayments, canPurchases]);

  useEffect(() => { void load(); return () => { requestVersion.current += 1; }; }, [load]);

  const name = mission?.greeting_name || staff?.full_name?.split(" ")[0] || "there";
  const due = mission?.due_count ?? 0;

  const sentence = useMemo(() => {
    if (!mission) return "";
    if (due === 0) return "Nothing is waiting on you. Enjoy the quiet.";
    const parts = [
      `${due} follow-up${due === 1 ? "" : "s"} need${due === 1 ? "s" : ""} you`,
      `₹${mission.revenue_at_risk_short} at stake`,
    ];
    if (mission.estimated_minutes > 0) parts.push(`about ${mission.estimated_minutes} minutes`);
    return parts.join(" · ") + ".";
  }, [mission, due]);

  // ── Queue actions ──────────────────────────────────────────────────────────
  const complete = (fu: Fu) => { void (async () => {
    await api.post(`/followups/${fu.id}/complete`, {});
    setQueue((q) => q ? q.filter((x) => x.id !== fu.id) : q);
    toast.success(`${fu.customer_name} — marked done`);
    void api.get<Mission>("/followups/mission").then(setMission).catch(() => {});
  })().catch((error: any) => toast.error(error?.detail || "Could not update follow-up")); };
  const call = (fu: Fu) => { void (async () => {
    const r = await api.post<{ phone?: string | null }>(`/followups/${fu.id}/contact`, { channel: "call" });
    const phone = r?.phone || fu.customer_phone;
    if (phone) await Linking.openURL(`tel:${phone.replace(/\s+/g, "")}`).catch(() => toast.error("Open the phone app manually."));
    else toast.error("No phone number on file");
  })().catch((error: any) => toast.error(error?.detail || "Could not update follow-up")); };
  const whatsapp = (fu: Fu) => { void (async () => {
    const r = await api.post<{ wa_url?: string | null }>(`/followups/${fu.id}/contact`, { channel: "whatsapp" });
    if (r?.wa_url) await Linking.openURL(r.wa_url).catch(() => toast.error("Open WhatsApp manually."));
    else toast.error("No WhatsApp number on file");
  })().catch((error: any) => toast.error(error?.detail || "Could not update follow-up")); };

  const loading = queue === null;

  // ── The business column ────────────────────────────────────────────────────
  const business = (
    <View style={{ gap: space.x6 }}>
      <Section eyebrow="The business" />
      <View style={isPhone ? { flexDirection: "row", flexWrap: "wrap", gap: space.x6, rowGap: space.x5 } : { gap: space.x5 }}>
        {canPayments ? <>
        <View style={isPhone ? { width: "46%" } : undefined}>
          <Stat label="Collected this month" value={pay?.collected_this_month} compactValue note="payments received" />
        </View>
        <View style={isPhone ? { width: "46%" } : undefined}>
          <Stat
            label="Outstanding"
            value={pay?.total_outstanding}
            compactValue
            note={mission && mission.overdue_payments > 0
              ? `${mission.overdue_payments} order${mission.overdue_payments === 1 ? "" : "s"} overdue`
              : pay ? `across ${pay.active_orders} orders` : "order count unavailable"}
            noteTone={mission && mission.overdue_payments > 0 ? "risk" : "soft"}
          />
        </View>
        </> : null}
        <View style={isPhone ? { width: "46%" } : undefined}>
          <Stat label="Open pipeline" value={stats?.open_pipeline} compactValue note={stats ? `${stats.quotes_this_month} quotations this month` : "quotation count unavailable"} />
        </View>
        <View style={isPhone ? { width: "46%" } : undefined}>
          <Stat label="Won this month" value={stats?.revenue_month} compactValue noteTone="ok" />
        </View>
      </View>

      {canQuotations && stats && stats.pending_approval > 0 ? (
        <NavigationLink href="/(admin)/quotations"
          accessibilityRole="link"
          accessibilityLabel={`${stats.pending_approval} quotation${stats.pending_approval === 1 ? "" : "s"} waiting for approval`}
          style={({ hovered }: any) => [
            {
              flexDirection: "row", alignItems: "center", gap: 8,
              minHeight: 44, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10,
              backgroundColor: hovered ? color.brassTint : "transparent",
              borderWidth: 1, borderColor: color.brassLine,
            },
            Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
          ]}
        >
          <Feather name="pen-tool" size={14} color={color.brassDeep} />
          <Txt v="sub" tone="brass" style={{ flex: 1 }}>
            {stats.pending_approval} quotation{stats.pending_approval === 1 ? "" : "s"} waiting for approval
          </Txt>
          <Feather name="arrow-right" size={14} color={color.brassDeep} />
        </NavigationLink>
      ) : null}

      {shortages.length > 0 ? (
        <NavigationLink href="/(admin)/purchases"
          accessibilityRole="link"
          accessibilityLabel={`${shortages.length} customer${shortages.length === 1 ? "" : "s"} awaiting reorder after a transfer`}
          style={({ hovered }: any) => [
            {
              flexDirection: "row", alignItems: "center", gap: 8,
              minHeight: 44, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10,
              backgroundColor: hovered ? color.riskTint : "transparent",
              borderWidth: 1, borderColor: color.risk,
            },
            Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
          ]}
        >
          <Feather name="alert-triangle" size={14} color={color.risk} />
          <Txt v="sub" tone="risk" style={{ flex: 1 }}>
            {shortages.length} customer{shortages.length === 1 ? "" : "s"} awaiting reorder after a transfer
          </Txt>
          <Feather name="arrow-right" size={14} color={color.risk} />
        </NavigationLink>
      ) : null}

      {canQuotations ? <View style={{ gap: space.x2 }}>
        <Section eyebrow="Pipeline" right={
          <NavigationLink href="/(admin)/quotations"
            style={{ minWidth: 44, minHeight: 44, justifyContent: "center" }}
            hitSlop={layout.hitSlop}
            accessibilityRole="link"
            accessibilityLabel="View all quotations"
          >
            <Txt v="caption" tone="soft">View all</Txt>
          </NavigationLink>
        } />
        {sectionErrors.recent ? (
          <Txt v="sub" tone="soft">Quotation activity is unavailable. Retry the workspace to refresh it.</Txt>
        ) : recent === null ? (
          <View style={{ gap: 12, paddingTop: 8 }}>
            <Skeleton h={16} /><Skeleton h={16} w="80%" /><Skeleton h={16} w="90%" />
          </View>
        ) : recent.length === 0 ? (
          <Txt v="sub" tone="soft" style={{ paddingVertical: 8 }}>No quotations yet.</Txt>
        ) : recent.map((q2, i) => (
          <Pressable
            key={q2.id}
            onPress={() => router.push(`/(admin)/quotations/${q2.id}` as any)}
            accessibilityRole="button"
            accessibilityLabel={`${q2.number}, ${q2.customer_name}`}
            style={({ hovered }: any) => [
              {
                paddingVertical: 10, gap: 3,
                marginHorizontal: -space.x3, paddingHorizontal: space.x3, borderRadius: 10,
                backgroundColor: hovered ? color.hoverWash : "transparent",
                borderTopWidth: i === 0 ? 0 : layout.hairline, borderTopColor: color.line,
              },
              Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
            ]}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Txt v="sub" tone="soft">{q2.number}</Txt>
              <Money value={q2.grand_total} size="sm" compact />
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Txt v="rowTitle" numberOfLines={1} style={{ flex: 1, marginRight: 8, fontSize: 14 }}>{q2.customer_name}</Txt>
              <StatusWord status={q2.status} />
            </View>
          </Pressable>
        ))}
      </View> : null}
    </View>
  );

  // ── Up next ───────────────────────────────────────────────────────────────
  const upNext = (
    <View style={{ gap: space.x2 }}>
      <Section
        eyebrow="Up next"
        right={due > 0 ? (
          <NavigationLink href="/(admin)/followups" accessibilityRole="link" accessibilityLabel="All follow-ups" style={{ minHeight: 44, justifyContent: "center" }} hitSlop={layout.hitSlop}>
            <Txt v="caption" tone="soft">All follow-ups</Txt>
          </NavigationLink>
        ) : undefined}
      />
      {loading ? (
        <View style={{ gap: 18, paddingTop: 12 }}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
              <Skeleton w={18} h={14} />
              <View style={{ flex: 1, gap: 6 }}><Skeleton h={14} w="55%" /><Skeleton h={11} w="85%" /></View>
              <Skeleton w={56} h={14} />
            </View>
          ))}
        </View>
      ) : sectionErrors.queue && queue.length === 0 ? (
        <ErrorState title="Follow-ups unavailable" subtitle="Reconnect or retry to see your queue." onRetry={() => void load(true)} />
      ) : queue.length === 0 ? (
        <View style={{ paddingVertical: space.x8, alignItems: "center", gap: 8 }}>
          <Feather name="coffee" size={20} color={color.inkFaint} />
          <Txt v="bodyMid">All clear. No follow-ups waiting.</Txt>
          <Txt v="sub" tone="soft">New tasks appear here as quotations age, payments come due, and customers go quiet.</Txt>
        </View>
      ) : (
        <View>
          {queue.map((fu, i) => (
            <View key={fu.id}>
              {i > 0 ? <Hairline /> : null}
              <QueueRow
                fu={fu}
                rank={i + 1}
                alwaysShow={!isDesktop}
                canUpdate={canUpdateFollowups}
                onDone={() => complete(fu)}
                onCall={() => call(fu)}
                onWhatsApp={() => whatsapp(fu)}
                onOpen={() => router.push("/(admin)/followups" as any)}
              />
            </View>
          ))}
        </View>
      )}
    </View>
  );

  return (
    <>
    <ScrollView
      style={{ flex: 1, backgroundColor: color.canvas }}
      contentContainerStyle={{ paddingBottom: space.x16 }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={color.inkSoft} />}
    >
      <View style={{ width: "100%", maxWidth: 1080, alignSelf: "center", paddingHorizontal: gutter }}>
        {loadError ? <Alert tone="warning" title="Some information is unavailable" description="Working sections remain available below." action={<Button label="Retry" variant="secondary" onPress={() => void load(true)} />} /> : null}
        {/* ── Hero ── */}
        <FadeIn>
          <View style={{ paddingTop: isPhone ? space.x4 : space.x8, paddingBottom: isPhone ? space.x4 : space.x6, gap: 10 }}>
            <Txt v="eyebrow">{todayLabel()}</Txt>
            <Txt v="display" style={isPhone ? { fontSize: 28, lineHeight: 36 } : undefined}>
              {greeting()}, {name}.
            </Txt>
            {mission ? (
              <Txt v="bodyMid" style={{ fontSize: 15.5 }}>{sentence}</Txt>
            ) : !canFollowups ? null : loadError ? <Txt v="sub" tone="soft">Some information is unavailable. Working sections remain below.</Txt> : (
              <Skeleton w={280} h={15} style={{ marginTop: 4 }} />
            )}
            {due > 0 ? (
              <View style={{ flexDirection: "row", marginTop: space.x2 }}>
                <Button
                  label="Open follow-ups"
                  icon="arrow-right"
                  onPress={() => router.push("/(admin)/followups" as any)}
                  size={isPhone ? "md" : "lg"}
                />
              </View>
            ) : null}
          </View>
        </FadeIn>

        {/* ── Body ── */}
        <FadeIn delay={60}>
          <>
          {isDesktop ? (
            <View style={{ flexDirection: "row", gap: space.x12 }}>
              {canFollowups ? <View style={{ flex: 1.9, minWidth: 0 }}>{upNext}</View> : null}
              <View style={{ width: layout.hairline, backgroundColor: color.line }} />
              <View style={{ flex: 1, minWidth: 0 }}>{business}</View>
            </View>
          ) : (
            <View style={{ gap: space.x10 }}>
              {canFollowups ? <>{upNext}<Hairline /></> : null}
              {business}
            </View>
          )}
          </>
        </FadeIn>
      </View>
    </ScrollView>
    </>
  );
}
