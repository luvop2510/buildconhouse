import { Component, type ErrorInfo, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { usePathname, useRouter } from "expo-router";

import { Text } from "@/src/components/AppText";
import { useAuth } from "@/src/state/auth";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { staffLandingPath } from "@/src/access-profiles";
import { captureRuntimeError } from "@/src/lib/monitoring";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

type Props = { children: ReactNode; resetKey: string; onHome: () => void };
type State = { failed: boolean; releaseFailure: boolean; resetKey: string };

/** Keep a failed page below the authenticated shell and its navigation. */
export class PageErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, releaseFailure: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> { return { failed: true }; }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // A different document or floor must never inherit the previous page's
    // failure. Updating state here also avoids a blank recovery render.
    return props.resetKey !== state.resetKey ? { failed: false, releaseFailure: false, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    // React catches render errors before global unhandled-error listeners can
    // see them. Send the exception through the same privacy allowlist.
    captureRuntimeError(error);
    if (typeof window !== "undefined") {
      // A rejected lazy import is cached by React. Retrying that tree cannot
      // load the current deployment; offer an explicit session-preserving
      // reload without discarding another mounted editor automatically.
      try {
        if ((window as Window & { __FORGE_IS_RELEASE_ERROR__?: (error: unknown) => boolean }).__FORGE_IS_RELEASE_ERROR__?.(error)) {
          this.setState({ releaseFailure: true });
        }
      } catch { /* A recovery helper must never break the error boundary. */ }
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <View testID="route-error-boundary" accessibilityLiveRegion="assertive" style={styles.page}>
      <Text accessibilityRole="header" style={type.titleLg}>{"This page couldn't open"}</Text>
      <Text style={[type.bodyMuted, styles.copy]}>{this.state.releaseFailure
        ? "An app update is available. Reload to open this page. Your sign-in is still active."
        : "Try opening it again, or use another page. Your sign-in is still active."}</Text>
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" accessibilityLabel={this.state.releaseFailure ? "Reload app" : "Try opening this page again"} onPress={() => {
          if (this.state.releaseFailure && typeof window !== "undefined") window.location.reload();
          else this.setState({ failed: false, releaseFailure: false });
        }} style={styles.primary}>
          <Text style={styles.primaryText}>{this.state.releaseFailure ? "Reload app" : "Try again"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Open workspace home" onPress={this.props.onHome} style={styles.secondary}>
          <Text style={type.body}>Open home</Text>
        </Pressable>
      </View>
    </View>;
  }
}

export function WorkspacePageBoundary({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { staff } = useAuth();
  const { selectedFloorId } = useFloorAccess();
  return <PageErrorBoundary resetKey={`${pathname}:${selectedFloorId}`} onHome={() => {
    router.replace(staffLandingPath(staff?.access_profile, staff?.access_grants, selectedFloorId) as any);
  }}>{children}</PageErrorBoundary>;
}

export function CustomerPageBoundary({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  return <PageErrorBoundary resetKey={pathname} onHome={() => router.replace("/(customer)/home")}>{children}</PageErrorBoundary>;
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.md, backgroundColor: colors.surface },
  copy: { maxWidth: 380, textAlign: "center" },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: spacing.sm },
  primary: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.lg, borderRadius: radius.md, backgroundColor: colors.brand },
  primaryText: { ...type.body, color: colors.onBrand },
  secondary: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.lg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
});
