// BuildCon House · Settings
import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { AdminPage } from "@/src/components/AdminPage";
import { Avatar, Card, ErrorState } from "@/src/components/ui";
import { toast } from "@/src/components/Toast";
import { api } from "@/src/api/client";
import { useAuth } from "@/src/state/auth";
import { brand, colors, radius, roleLabels, spacing, type } from "@/src/theme/tokens";
import { useBp } from "@/src/design/responsive";

type SessionInfo = {
  id: string; device_label?: string | null; login_method: string;
  created_at: string; last_seen_at: string; current: boolean;
};

export default function Settings() {
  const { staff, logout } = useAuth();
  const { isPhone } = useBp();
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [revoking, setRevoking] = useState(false);
  const [sessionsError, setSessionsError] = useState(false);
  const [revokingSession, setRevokingSession] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(false);
    try {
      const list = await api.get<SessionInfo[]>("/auth/sessions");
      setSessions(list);
    } catch {
      setSessionsError(true);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  const doLogoutAll = async () => {
    setRevoking(true);
    try {
      await api.post("/auth/sessions/logout-all");
      await logout();
      router.replace("/(auth)/login");
    } catch {
      setRevoking(false);
      toast.error("Could not sign out of all devices. Try again.");
    }
  };

  const confirmLogoutAll = () => {
    if (Platform.OS === "web") {
      if (window.confirm("Sign out of every device where you're logged in?")) doLogoutAll();
      return;
    }
    Alert.alert("Log out everywhere?", "You'll be signed out on every device, including this one.", [
      { text: "Cancel", style: "cancel" },
      { text: "Log out everywhere", style: "destructive", onPress: doLogoutAll },
    ]);
  };

  const revokeOne = async (id: string) => {
    if (revokingSession) return;
    setRevokingSession(id);
    try {
      await api.delete(`/auth/sessions/${id}`);
      setSessions((cur) => cur.filter((s) => s.id !== id));
    } catch { toast.error("Could not revoke this session. Try again."); }
    finally { setRevokingSession(null); }
  };

  const timeAgo = (iso: string) => {
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  const sections = [
    { title: "Profile", items: [
      { label: "Name", value: staff?.full_name, icon: "user" as const },
      { label: "Email", value: staff?.email, icon: "mail" as const },
      { label: "Role", value: roleLabels[staff?.role || ""], icon: "shield" as const },
    ] },
    { title: "Organization", items: [
      { label: "Company", value: brand.name, icon: "home" as const },
      { label: "Time zone", value: "Asia/Kolkata (GMT+5:30)", icon: "clock" as const },
    ] },
  ];

  const workspaceRows: { icon: keyof typeof Feather.glyphMap; label: string; hint: string; href: string; testId: string; roles?: string[] }[] = [
    { icon: "briefcase", label: "Company", hint: "Name, contact, logo", href: "/(admin)/settings-company", testId: "settings-nav-company" },
    { icon: "file-text", label: "PDF branding", hint: "Footer, terms, watermark", href: "/(admin)/settings-pdf", testId: "settings-nav-pdf" },
    { icon: "users", label: "Team", hint: "Add, edit roles, deactivate", href: "/(admin)/team", testId: "settings-nav-team" },
    { icon: "shield", label: "Roles & permissions", hint: "What each role can do", href: "/(admin)/settings-permissions", testId: "settings-nav-permissions" },
    { icon: "shield", label: "Personal access", hint: "Worker access by page, action & floor", href: "/(admin)/settings-access-grants", testId: "settings-nav-access-grants", roles: ["owner", "admin"] },
    { icon: "bell", label: "Notifications", hint: "Channels & follow-up rules", href: "/(admin)/settings-notifications", testId: "settings-nav-notifications" },
    { icon: "user-plus", label: "Walk-in setup", hint: "Manage lead sources", href: "/(admin)/settings-walkins", testId: "settings-nav-walkins", roles: ["owner", "admin", "manager"] },
    { icon: "database", label: "Catalog tools", hint: "Import, export, backup", href: "/(admin)/settings-catalog", testId: "settings-nav-catalog" },
    { icon: "activity", label: "System", hint: "Health, version, storage", href: "/(admin)/settings-system", testId: "settings-nav-system" },
    { icon: "file-text", label: "Privacy & data", hint: "What we collect, deletion requests", href: "/(admin)/settings-privacy", testId: "settings-nav-privacy" },
    { icon: "file-text", label: "Terms of service", hint: "Usage terms & account terms", href: "/(admin)/settings-terms", testId: "settings-nav-terms" },
  ];

  return (
    <AdminPage title="Settings" subtitle="Profile, organization & preferences">
      {/* Profile hero */}
      <View style={styles.hero}>
        <Avatar name={staff?.full_name} size={64} tone="brand" />
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text style={type.titleLg}>{staff?.full_name || "—"}</Text>
          <Text style={type.bodyMuted}>{staff?.email}</Text>
          <View style={styles.rolePill}>
            <Feather name="shield" size={11} color={colors.brand} />
            <Text style={styles.rolePillText}>{roleLabels[staff?.role || ""] || staff?.role || "Team"}</Text>
          </View>
        </View>
      </View>

      {sections.filter(s => s.title !== "Profile").map((s) => (
        <Card key={s.title} style={{ padding: 0 }} variant="flat">
          <Text style={[type.overline, { padding: spacing.md, paddingBottom: 8 }]}>{s.title}</Text>
          {s.items.map((it, i) => (
            <View
              key={it.label}
              style={[styles.row, i === 0 ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.divider }]}
            >
              <View style={styles.itemIcon}>
                <Feather name={it.icon} size={14} color={colors.onSurfaceMuted} />
              </View>
              <Text style={[type.bodyMuted, { flex: 1 }]}>{it.label}</Text>
              <Text numberOfLines={isPhone ? 2 : 1} style={[
                styles.rowValue,
                {
                fontSize: 14,
                fontFamily: type.bodyStrong.fontFamily,
                fontWeight: "500",
                color: colors.onSurface,
                },
              ]}>{it.value || "—"}</Text>
            </View>
          ))}
        </Card>
      ))}

      {[
        { title: "Business & documents", ids: ["company", "pdf", "catalog", "walkins"] },
        { title: "People & access", ids: ["team", "permissions", "access-grants"] },
        { title: "Preferences & support", ids: ["notifications", "system", "privacy", "terms"] },
      ].map(group => (
      <Card key={group.title} style={{ padding: 0 }} variant="flat">
        <Text style={[type.overline, { padding: spacing.md, paddingBottom: 8 }]}>{group.title}</Text>
        {workspaceRows.filter(r => group.ids.includes(r.testId.replace("settings-nav-", ""))).filter((r) => !r.roles || r.roles.includes(staff?.role || "")).map((r, i) => (
          <Pressable
            key={r.href}
            testID={r.testId}
            accessibilityRole="link"
            accessibilityLabel={r.label}
            onPress={() => router.push(r.href as any)}
            style={({ pressed }) => [
              styles.row,
              i === 0 ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.divider },
              { opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <View style={styles.itemIcon}>
              <Feather name={r.icon} size={14} color={colors.onSurfaceMuted} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontFamily: type.bodyStrong.fontFamily, fontWeight: "500", color: colors.onSurface }}>{r.label}</Text>
              <Text style={type.caption}>{r.hint}</Text>
            </View>
            <Feather name="chevron-right" size={16} color={colors.onSurfaceMuted} />
          </Pressable>
        ))}
      </Card>
      ))}

      {/* Security — active sessions / trusted devices */}
      <Card style={{ padding: 0 }} variant="flat">
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: spacing.md, paddingBottom: 8 }}>
          <Text style={type.overline}>Security · Active sessions</Text>
          {sessionsLoading ? <ActivityIndicator size="small" color={colors.onSurfaceMuted} /> : null}
        </View>
        <Pressable
          testID="settings-nav-password"
          accessibilityRole="link"
          onPress={() => router.push("/(admin)/settings-password" as any)}
          style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
        >
          <View style={styles.itemIcon}>
            <Feather name="lock" size={14} color={colors.onSurfaceMuted} />
          </View>
          <Text style={[type.bodyMuted, { flex: 1 }]}>Change password</Text>
          <Feather name="chevron-right" size={16} color={colors.onSurfaceMuted} />
        </Pressable>
        <Pressable testID="settings-nav-mfa" accessibilityRole="link" accessibilityLabel="Authenticator MFA"
          onPress={() => router.push("/(admin)/settings-mfa" as any)} style={styles.row}>
          <View style={styles.itemIcon}><Feather name="shield" size={14} color={colors.onSurfaceMuted} /></View>
          <Text style={[type.bodyMuted, { flex: 1 }]}>Authenticator MFA</Text>
          <Feather name="chevron-right" size={16} color={colors.onSurfaceMuted} />
        </Pressable>
        {sessionsError ? <ErrorState title="Couldn't load active sessions" subtitle="Your session list is unavailable. Retry to review signed-in devices." onRetry={loadSessions} /> : !sessionsLoading && sessions.length === 0 ? (
          <Text style={[type.bodyMuted, { padding: spacing.md, paddingTop: 0 }]}>No active sessions found.</Text>
        ) : sessions.map((s) => (
          <View
            key={s.id}
            style={[styles.row, { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.divider }]}
          >
            <View style={styles.itemIcon}>
              <Feather name={s.login_method === "google" ? "smartphone" : "monitor"} size={14} color={colors.onSurfaceMuted} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13.5, fontWeight: "600", color: colors.onSurface }}>
                {s.device_label || "Unknown device"} {s.current ? "· This device" : ""}
              </Text>
              <Text style={type.caption}>
                {s.login_method === "google" ? "Google" : "Password"} · Active {timeAgo(s.last_seen_at)}
              </Text>
            </View>
            {!s.current ? (
              <Pressable testID={`revoke-session-${s.id}`} accessibilityRole="button" accessibilityLabel={`Sign out ${s.device_label || "device"}`} accessibilityState={{ disabled: !!revokingSession, busy: revokingSession === s.id }} disabled={!!revokingSession} style={{ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }} onPress={() => revokeOne(s.id)}>
                <Feather name="x-circle" size={16} color={colors.onSurfaceMuted} />
              </Pressable>
            ) : null}
          </View>
        ))}
        <Pressable
          testID="logout-all-devices"
          accessibilityRole="button"
          onPress={confirmLogoutAll}
          disabled={revoking}
          style={({ pressed }) => [styles.logoutAllRow, { opacity: pressed || revoking ? 0.7 : 1 }]}
        >
          <Feather name="shield-off" size={14} color={colors.error} />
          <Text style={styles.logoutAllLabel}>{revoking ? "Signing out everywhere…" : "Log out of all devices"}</Text>
        </Pressable>
      </Card>

      <Pressable
        testID="settings-logout"
        accessibilityRole="button"
        onPress={async () => { await logout(); router.replace("/(auth)/login"); }}
        style={({ pressed }) => [styles.logout, { opacity: pressed ? 0.88 : 1 }]}
      >
        <Feather name="log-out" size={16} color={colors.error} />
        <Text style={{
          color: colors.error,
          fontSize: 14,
          fontFamily: type.titleMd.fontFamily,
          fontWeight: "600",
        }}>Sign out</Text>
      </Pressable>

      <Text style={[type.caption, { textAlign: "center", marginTop: spacing.sm }]}>
        {brand.name} · {brand.tagline}
      </Text>
    </AdminPage>
  );
}

const styles = StyleSheet.create({
  hero: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.lg,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  rolePill: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.brandTint,
    marginTop: 4,
  },
  rolePillText: {
    fontSize: 11,
    fontFamily: type.titleMd.fontFamily,
    fontWeight: "600",
    color: colors.brand,
    letterSpacing: 0.1,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
  },
  // Account/company values are user-controlled. Constrain their column so a
  // long email or organisation name never pushes the label/icon off a phone.
  rowValue: { flexShrink: 1, maxWidth: "58%", textAlign: "right" },
  itemIcon: {
    width: 32, height: 32, borderRadius: 10,
    backgroundColor: colors.surfaceTertiary,
    alignItems: "center", justifyContent: "center",
  },
  logout: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    padding: spacing.md,
    backgroundColor: colors.errorBg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.errorBorder,
  },
  logoutAllRow: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm,
    minHeight: 44, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  logoutAllLabel: {
    color: colors.error, fontSize: 14,
    fontFamily: type.titleMd.fontFamily, fontWeight: "600",
  },
});
