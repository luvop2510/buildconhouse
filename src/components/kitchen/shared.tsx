import { useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View, type ViewStyle } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { Text } from "@/src/components/AppText";
import { Alert, ErrorState, LoadingState } from "@/src/components/ds";
import { useBp } from "@/src/design/responsive";
import { KitchenButton as Button, kitchenColors as colors, kitchenType as type } from "./KitchenPrimitives";
import { useRequireFloorAccessState } from "@/src/hooks/use-floor-access";
import { KITCHEN_FLOOR_ID } from "@/src/constants/floors";
import { kitchenRequestKey } from "@/src/api/kitchenProjects";
import { spacing } from "@/src/theme/tokens";
import { KitchenOption } from "./KitchenFilters";
import { useAuth } from "@/src/state/auth";
import { KITCHEN_OWNER_ONLY } from "@/src/design/navigation";
import { KitchenCustomerSearch } from "./KitchenCustomerSearch";
import { hasGrantAccess } from "@/src/team-delegation";

/** The header and content share one scroll owner on every viewport. */
export function KitchenPage({ title, subtitle, overline, right, back, children, contentStyle, compactHeader = false, customerSearch = true }: {
  title: string; subtitle?: string | null; overline?: string; right?: ReactNode; back?: () => void;
  children: ReactNode; scroll?: boolean; contentStyle?: ViewStyle; headerBorder?: boolean; compactHeader?: boolean; customerSearch?: boolean;
}) {
  const { isPhone } = useBp();
  return <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface }}>
    <ScrollView testID="kitchen-page-scroll" keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator contentContainerStyle={{ flexGrow: 1, paddingHorizontal: isPhone ? 16 : 32, paddingTop: compactHeader ? 8 : isPhone ? 20 : 32, paddingBottom: isPhone ? 32 : 48 }}>
      <View style={[{ width: "100%", maxWidth: 1560, alignSelf: "center", gap: compactHeader ? 12 : isPhone ? 24 : 32 }, contentStyle]}>
        {compactHeader ? <View testID="kitchen-compact-header" style={{ flexDirection: isPhone ? "column" : "row", alignItems: isPhone ? "stretch" : "center", gap: 8, minHeight: 44 }}>
          <View style={{ flex: isPhone ? undefined : 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 }}>
            {back ? <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={back} testID="kitchen-page-back" style={{ minWidth: 44, minHeight: 44, justifyContent: "center", alignItems: "center" }}><Feather name="arrow-left" size={20} color={colors.onSurface} /></Pressable> : null}
            <Text accessibilityRole="header" aria-level={1} numberOfLines={1} style={[type.titleMd, { flex: 1, minWidth: 0 }]}>{title}</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: isPhone ? "space-between" : "flex-end", gap: 8 }}>
            {right}
            {customerSearch ? <KitchenCustomerSearch compact /> : null}
          </View>
        </View> : <View style={{ gap: 16, borderBottomWidth: 1, borderBottomColor: colors.divider, paddingBottom: 24 }}>
          {back ? <Button label="Back" icon="arrow-left" variant="ghost" onPress={back} testID="kitchen-page-back" /> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 20 }}>
            <View style={{ flexBasis: 400, flexGrow: 1, flexShrink: 1, minWidth: 0, maxWidth: "100%", gap: 6 }}>
              {overline ? <Text style={type.overline}>{overline}</Text> : null}
              <Text accessibilityRole="header" aria-level={1} style={[type.titleLg, { fontSize: isPhone ? 26 : 28 }]}>{title}</Text>
              {subtitle ? <Text style={[type.bodyMuted, { maxWidth: 760 }]}>{subtitle}</Text> : null}
            </View>
            <View style={{ maxWidth: "100%", flexShrink: 1, flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{customerSearch ? <KitchenCustomerSearch /> : null}{right}</View>
          </View>
        </View>}
        {children}
      </View>
    </ScrollView>
  </View>;
}
export function KitchenFloor({ children }: { children: ReactNode }) {
  const access = useRequireFloorAccessState(KITCHEN_FLOOR_ID);
  const { staff } = useAuth();
  if (KITCHEN_OWNER_ONLY && staff && staff.role !== "owner" && (!staff.custom_access || !hasGrantAccess(staff.access_grants, KITCHEN_FLOOR_ID, "kitchen_projects"))) return <KitchenPage title="Kitchen" customerSearch={false}><ErrorState title="Owner access required" subtitle="Kitchen is currently available to the owner only." /></KitchenPage>;
  if (access.error) return <KitchenPage title="Kitchen projects" customerSearch={false}><ErrorState title="Kitchen access unavailable" subtitle={access.error} onRetry={access.retry} /></KitchenPage>;
  if (!access.ready) return <KitchenPage title="Kitchen projects" customerSearch={false}><LoadingState label="Checking Kitchen access…" /></KitchenPage>;
  return <>{children}</>;
}
export function KitchenPanel({ title, children }: { title?: string; children: ReactNode }) {
  const { isPhone } = useBp();
  return <View style={{ width: "100%", maxWidth: "100%", gap: isPhone ? 12 : 16, minWidth: 0, backgroundColor: colors.surfaceSecondary, padding: isPhone ? 12 : 20, borderRadius: 8, borderWidth: 1, borderColor: colors.border }}>
    {title ? <View style={{ paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.divider }}><Text accessibilityRole="header" aria-level={2} style={type.titleMd}>{title}</Text></View> : null}{children}
  </View>;
}
export function KitchenDetails({ items, testID }: { items: { label: string; value: string }[]; testID?: string }) {
  const { isPhone } = useBp();
  return <View testID={testID} style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
    {items.map(({ label, value }) => <View key={label} style={{ flexBasis: isPhone ? "45%" : "30%", flexGrow: 1, minWidth: 0, padding: 12, borderWidth: 1, borderColor: colors.controlBorder, borderRadius: 6, backgroundColor: colors.surface }}>
      <Text style={type.body}><Text style={type.caption}>{label}:</Text>{"\n"}<Text style={type.bodyStrong}>{value}</Text></Text>
    </View>)}
  </View>;
}
export function Choice<T extends string>({ label, value, values, onChange, disabled, testID }: {
  label: string; value: T; values: readonly T[]; onChange: (value: T) => void; disabled?: boolean; testID?: string;
}) {
  return <View style={{ gap: spacing.sm }}><Text style={type.label}>{label}</Text>
    <View testID={testID} role="group" accessibilityLabel={label} style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
      {values.map(option => <KitchenOption key={option} accessibilityLabel={`${label}: ${option || "Not recorded"}`} label={({ creation: "When the lead is created", conversion: "When converted to a project", owner: "Owner only", all_authorized: "All staff with Kitchen access", target_completion: "Target completion date", "": "Not recorded" } as Record<string, string>)[option] || option} active={value === option} disabled={disabled} onPress={() => onChange(option)} testID={testID ? `${testID}-${option.toLowerCase().replaceAll(" ", "-")}` : undefined} />)}
    </View>
  </View>;
}
export function ErrorNotice({ error, stale, onReload, recordLabel = "project" }: { error: string | null; stale?: boolean; onReload?: () => void; recordLabel?: string }) {
  return error ? <View style={{ gap: spacing.sm }}><Alert tone="error" title={stale ? `This ${recordLabel} changed` : "Could not save"} description={error} />{stale && onReload ? <Button label="Reload current record" variant="secondary" onPress={onReload} /> : null}</View> : null;
}
export function errorText(error: unknown) {
  const detail = (error as { detail?: unknown })?.detail;
  if (typeof detail === "string") {
    try { const parsed = JSON.parse(detail); return Array.isArray(parsed) ? parsed.map(item => `${item.loc?.slice(-1)[0] || "Value"}: ${item.msg || "Invalid value"}`).join(". ") : parsed.message || parsed.detail || detail; } catch { return detail; }
  }
  return error instanceof Error ? error.message : "Please try again. Your entries have been kept.";
}
/** A retry keeps its command key; a changed draft starts a distinct command. */
export function useKitchenSubmission() {
  const pending = useRef(false);
  const receipt = useRef<{ fingerprint: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const submit = async <T,>(fingerprint: unknown, work: (key: string) => Promise<T>, success: (result: T) => void) => {
    if (pending.current) return false;
    const serialized = JSON.stringify(fingerprint);
    if (receipt.current?.fingerprint !== serialized) receipt.current = { fingerprint: serialized, key: kitchenRequestKey() };
    pending.current = true; setBusy(true); setError(null); setStale(false);
    try { const result = await work(receipt.current.key); receipt.current = null; success(result); return true; }
    catch (cause) { setError(`${errorText(cause)} Your entries have been kept.`); setStale((cause as { status?: number })?.status === 409); return false; }
    finally { pending.current = false; setBusy(false); }
  };
  return { busy, error, stale, submit, setError, clearFeedback: () => { setError(null); setStale(false); } };
}
export function displayDate(value?: string | null) {
  if (!value) return "—";
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00+05:30` : value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
}
export function rupees(value?: string | null) {
  if (!value) return "—";
  // Render normalized decimal strings without performing financial arithmetic.
  const [whole, fraction] = value.split(".");
  return `₹${whole.replace(/\B(?=(\d{2})+\d(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""}`;
}

/** Unknown legacy totals must never be displayed as zero. */
export function historicalCount(value: number | null | undefined, known?: number) {
  return value == null ? `Historical count unavailable${known != null ? ` · Newly recorded: ${known}` : ""}` : String(value);
}
