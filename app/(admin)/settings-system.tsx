// Settings > System — surfaces the existing GET /health/system backend
// (already fully working before this screen existed) so mongo/supabase
// connectivity, catalog counts, version, and warnings are visible in-app
// instead of only reachable via a raw API call.
import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { api } from "@/src/api/client";
import { SettingsPage as AdminPage } from "@/src/components/settings/SettingsPage";
import { Card, ErrorState, Skeleton } from "@/src/components/ui";
import { useBp } from "@/src/design/responsive";
import { colors, spacing, type } from "@/src/theme/tokens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type Health = {
  backend: string; version: string;
  mongo: { connected: boolean; is_local: boolean; error: string | null };
  supabase: { configured: boolean; connected: boolean; error: string | null };
  counts: Record<string, number>;
  warnings: string[];
  healthy: boolean;
};

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: ok ? colors.success : colors.error }} />
  );
}

export default function SettingsSystem() {
  const router = useRouter();
  const { gutter, isPhone } = useBp();
  const insets = useSafeAreaInsets();
  const [health, setHealth] = useState<Health | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(() => {
    setLoadError(false);
    return api.get<Health>("/health/system").then(setHealth).catch(() => setLoadError(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  return (
    <AdminPage title="System" subtitle="Live diagnostics — no configuration here, read-only" back={() => router.back()} scroll={false} contentStyle={{ paddingHorizontal: 0, paddingTop: 0 }}>
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />}
        contentContainerStyle={{
          gap: spacing.lg,
          paddingHorizontal: gutter,
          paddingTop: isPhone ? spacing.md : spacing.xl,
          paddingBottom: isPhone ? 132 + insets.bottom : spacing.xxxl,
        }}
      >
        {loadError ? <ErrorState title="Couldn't load system health" onRetry={load} /> : !health ? (
          <Card style={{ gap: 12 }}>
            <Skeleton w="60%" />
            <Skeleton w="100%" h={80} />
          </Card>
        ) : (
          <>
            <Card style={{ gap: spacing.md }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm }}>
                <Text style={type.overline}>Overall</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <StatusDot ok={health.healthy} />
                  <Text style={type.bodyStrong}>{health.healthy ? "Healthy" : "Attention needed"}</Text>
                </View>
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: spacing.md }}>
                <Text style={[type.bodyMuted, { flexShrink: 1 }]}>Version</Text>
                <Text style={[type.body, { flexShrink: 1, textAlign: "right" }]} numberOfLines={2}>{health.version}</Text>
              </View>
            </Card>

            <Card style={{ gap: spacing.sm }}>
              <Text style={type.overline}>Connections</Text>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6 }}>
                <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Feather name="database" size={14} color={colors.onSurfaceMuted} />
                  <Text style={type.body}>MongoDB{health.mongo.is_local ? " (local)" : " (Atlas)"}</Text>
                </View>
                <StatusDot ok={health.mongo.connected} />
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6 }}>
                <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Feather name="hard-drive" size={14} color={colors.onSurfaceMuted} />
                  <Text style={type.body}>Supabase storage</Text>
                </View>
                <StatusDot ok={health.supabase.connected} />
              </View>
            </Card>

            <Card style={{ gap: spacing.sm }}>
              <Text style={type.overline}>Data</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
                {Object.entries(health.counts).map(([key, val]) => (
                  <View key={key} style={{ minWidth: 96 }}>
                    <Text style={{ fontSize: 20, fontWeight: "700" }}>{val}</Text>
                    <Text style={type.caption}>{key.replace(/_/g, " ")}</Text>
                  </View>
                ))}
              </View>
            </Card>

            {health.warnings.length > 0 ? (
              <Card style={{ gap: spacing.sm, backgroundColor: colors.warningBg, borderColor: colors.warningBorder }}>
                <Text style={type.overline}>Warnings</Text>
                {health.warnings.map((w, i) => (
                  <Text key={i} style={type.body}>• {w}</Text>
                ))}
              </Card>
            ) : null}
          </>
        )}
      </ScrollView>
    </AdminPage>
  );
}
