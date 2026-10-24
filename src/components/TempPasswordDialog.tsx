// Credential display. Team passwords are permanent and visible to the owner;
// customer invites keep their separate temporary-password policy. Credentials
// are held only in local state and cleared when the caller closes this dialog.
import * as Clipboard from "expo-clipboard";
import { useLayoutEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { Button, Sheet } from "@/src/components/ui";
import { toast } from "@/src/components/Toast";
import { colors, radius, spacing, type } from "@/src/theme/tokens";
import { useBp } from "@/src/design/responsive";

export type TempPasswordResult = {
  delivery_method: "manual" | "email";
  temporary_password?: string | null;
  password?: string | null;
  expires_at?: string | null;
  message?: string;
};

export function TempPasswordDialog({
  visible, onClose, title, result, permanent = false,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  result: TempPasswordResult | null;
  permanent?: boolean;
}) {
  const { isPhone } = useBp();
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const copyGeneration = useRef(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const password = result?.password || result?.temporary_password;

  useLayoutEffect(() => {
    copyGeneration.current += 1;
    setCopied(false);
    setCopying(false);
    return () => {
      copyGeneration.current += 1;
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, [visible, password]);

  const close = () => {
    copyGeneration.current += 1;
    if (copyTimer.current) clearTimeout(copyTimer.current);
    setCopied(false);
    setCopying(false);
    onClose();
  };

  const copy = async () => {
    if (!password || !visible || copying) return;
    const generation = copyGeneration.current;
    setCopying(true);
    try {
      // Expo's browser fallback treats an attempted execCommand as success
      // even when it returns false. Require an acknowledged browser write;
      // the selectable password remains available when copying is blocked.
      const success = Platform.OS === "web"
        ? typeof navigator !== "undefined" && !!navigator.clipboard && await navigator.clipboard.writeText(password).then(() => true)
        : await Clipboard.setStringAsync(password);
      if (generation !== copyGeneration.current) return;
      if (!success) throw new Error("Clipboard unavailable");
      setCopied(true);
      toast.success("Copied to clipboard");
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => {
        if (generation === copyGeneration.current) setCopied(false);
      }, 2000);
    } catch {
      if (generation === copyGeneration.current) {
        setCopied(false);
        toast.error("Could not copy. Select the password to copy it manually.");
      }
    } finally {
      if (generation === copyGeneration.current) setCopying(false);
    }
  };

  const expiresLabel = (() => {
    if (!result?.expires_at) return null;
    try {
      return new Date(result.expires_at).toLocaleString("en-IN", {
        day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
      });
    } catch { return null; }
  })();

  return (
    <Sheet
      visible={visible}
      onClose={close}
      title={title}
      variant="modal"
      testID="temp-password-dialog"
    >
      <View style={{ padding: isPhone ? spacing.lg : spacing.xl, gap: spacing.lg }}>
        {result?.delivery_method === "manual" && password ? (
          <>
            <Text style={type.bodyMuted}>
              {permanent ? "Share this password with the member. You can view their current password in Team." : "Share this password with them directly (WhatsApp, SMS, or email). It will not be shown again after you close this dialog."}
            </Text>
            <View style={styles.pwBox}>
              <Text testID="temp-password-value" selectable numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.65} style={styles.pwText}>
                {password}
              </Text>
            </View>
            <Button
              testID="temp-password-copy"
              label={copied ? "Copied" : "Copy password"}
              icon={copied ? "check" : "copy"}
              variant={copied ? "secondary" : "primary"}
              onPress={copy}
              loading={copying}
              fullWidth
            />
            {permanent ? <Text style={type.caption}>The member can change this password in Settings using their old password. The owner can also reset it.</Text> : expiresLabel ? (
              <View style={styles.expiryRow}>
                <Text style={type.caption}>
                  Expires {expiresLabel} if unused. They&apos;ll be asked to set their own
                  password on first login.
                </Text>
              </View>
            ) : null}
          </>
        ) : (
          <Text style={type.bodyMuted}>
            {result?.message || "Invite sent."}
          </Text>
        )}
        <Button testID="temp-password-done" label="Done" variant="ghost" onPress={close} fullWidth />
      </View>
    </Sheet>
  );
}

const styles = {
  pwBox: {
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    alignItems: "center" as const,
  },
  pwText: {
    fontSize: 20,
    fontWeight: "700" as const,
    letterSpacing: 1.5,
    color: colors.onSurface,
    fontFamily: "Inter-Regular",
  },
  expiryRow: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.sm,
    padding: spacing.sm,
  },
};
