// Public, unauthenticated Terms of Service — the hosted-URL half of the
// store-submission requirement, mirroring app/privacy.tsx exactly.
// App Store Connect / Google Play Console both require a stable URL to this
// content in their submission forms; app/(admin)/settings-terms.tsx is the
// in-app half, behind staff auth. Both render TermsOfServiceContent so the
// copy can't drift.
//
// Lives outside every route group ((auth)/(admin)/(customer)) on purpose —
// AuthGate (app/_layout.tsx) redirects any unauthenticated visitor to
// /(auth)/login by default, with an explicit carve-out for this route's
// top-level "terms" segment so it stays reachable without signing in.
import { useRouter } from "expo-router";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BuildConLogo } from "@/src/design/BrandLogo";
import { Txt } from "@/src/design/components";
import { useBp } from "@/src/design/responsive";
import { color, font, space } from "@/src/design/tokens";
import { TermsOfServiceContent } from "@/src/components/TermsOfServiceContent";

export default function PublicTermsOfService() {
  const router = useRouter();
  const { isPhone, gutter } = useBp();
  const insets = useSafeAreaInsets();

  return (
    <View style={{ flex: 1, backgroundColor: color.canvas }}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: gutter,
          paddingTop: Math.max(24, insets.top + 16),
          paddingBottom: Math.max(32, insets.bottom + 24),
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ width: "100%", maxWidth: 640, alignSelf: "center", gap: space.x6 }}>
          <View style={{ gap: 8 }}>
            <BuildConLogo height={isPhone ? 28 : 32} />
            <Txt v="display" style={isPhone ? { fontSize: 26, lineHeight: 32 } : { fontSize: 30, lineHeight: 38 }}>
              Terms of Service
            </Txt>
            <Txt v="bodyMid">The terms that govern using this app.</Txt>
          </View>

          <TermsOfServiceContent />

          <Pressable accessibilityRole="link" style={{ minHeight: 44, justifyContent: "center" }} onPress={() => router.push("/(auth)/login")} hitSlop={8}>
            <Text style={{ fontFamily: font.medium, fontSize: 13, color: color.brassDeep }}>← Back to sign in</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
