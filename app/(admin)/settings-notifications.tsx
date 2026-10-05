// Settings > Notifications — honest status, not a fake "connected" toggle.
// No email/SMS/WhatsApp-Business-API provider is integrated anywhere in this
// codebase (verified during the Phase 6 audit) — building a working send
// integration needs real provider credentials, which is a product decision,
// not something to fake here. What IS real and shown below: the follow-up
// rule engine (services/followup_engine.py) already runs continuously and
// its current rule set + live counts are surfaced honestly.
import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Text } from "@/src/components/AppText";

import { api } from "@/src/api/client";
import { SettingsPage as AdminPage } from "@/src/components/settings/SettingsPage";
import { Card, Skeleton, ErrorState, EmptyState } from "@/src/components/ui";
import { colors, spacing, type } from "@/src/theme/tokens";

type Rule = { rule_type: string; label: string; category: string; description: string; active_count: number };

function IntegrationRow({ icon, name, status, ok, note }: { icon: any; name: string; status: string; ok: boolean; note: string }) {
  return (
    <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" }}>
      <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: colors.surfaceTertiary, alignItems: "center", justifyContent: "center" }}>
        <Feather name={icon} size={15} color={colors.onSurfaceMuted} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 4 }}>
          <Text style={[type.bodyStrong, { flexShrink: 1 }]}>{name}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: ok ? colors.success : colors.onSurfaceMuted }} />
            <Text style={type.caption}>{status}</Text>
          </View>
        </View>
        <Text style={[type.caption, { marginTop: 2 }]}>{note}</Text>
      </View>
    </View>
  );
}

export default function SettingsNotifications() {
  const router = useRouter();
  const [rules, setRules] = useState<Rule[] | null>(null);

  const [error, setError] = useState(false);
  const load = useCallback(() => {
    setError(false);
    api.get<Rule[]>("/followups/config/rules").then(setRules).catch(() => setError(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <AdminPage title="Notifications" subtitle="Channels & follow-up rules" back={() => router.back()}>
      <View style={{ gap: spacing.lg }}>
        <Card style={{ gap: spacing.md }}>
          <Text style={type.overline}>Channels</Text>
          <IntegrationRow icon="mail" name="Email" status="Not connected" ok={false} note="Email notifications are not enabled for this workspace." />
          <View style={{ height: 1, backgroundColor: colors.divider }} />
          <IntegrationRow icon="message-circle" name="WhatsApp" status="Manual send" ok={true} note="Follow-ups already generate a ready-to-send WhatsApp message that your team opens and sends from their own phone — there's no automated bulk sender." />
        </Card>

        <Card style={{ gap: spacing.sm }}>
          <Text style={type.overline}>Follow-up rules — live</Text>
          <Text style={type.caption}>Automatic rules and their current active follow-ups. Contact your administrator to change how rules are configured.</Text>
          {error ? <ErrorState title="Could not load follow-up rules" onRetry={load} /> : rules?.length === 0 ? <EmptyState title="No follow-up rules configured" /> : !rules ? (
            <Skeleton w="100%" h={60} />
          ) : (
            rules.map((r, i) => (
              <View key={r.rule_type} style={{ paddingTop: i === 0 ? spacing.sm : 0, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.divider, paddingVertical: 8 }}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 4 }}>
                  <Text style={[type.bodyStrong, { flexShrink: 1 }]}>{r.label}</Text>
                  <Text style={[type.caption, { fontWeight: "700" }]}>{r.active_count} active</Text>
                </View>
                <Text style={type.caption}>{r.description}</Text>
              </View>
            ))
          )}
        </Card>
      </View>
    </AdminPage>
  );
}
