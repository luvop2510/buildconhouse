import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import { Pressable, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { useBp } from './responsive';
import { color, font, layout, radius, space } from './tokens';

/** Header shared by regular pages, reading views and operational workspaces. */
export function PageHeader({ title, subtitle, actions, back, overline, testID, dense, embedded = false }: {
  title: string; subtitle?: string | null; actions?: React.ReactNode;
  back?: () => void; overline?: string; testID?: string; dense?: boolean; embedded?: boolean;
}) {
  const { isPhone, isDesktop, gutter } = useBp();
  return <View testID={testID} style={{ paddingHorizontal: embedded ? 0 : gutter,
    paddingTop: dense ? space.x3 : isPhone ? space.x4 : space.x6,
    paddingBottom: dense ? space.x3 : isPhone ? space.x4 : space.x5,
    borderBottomWidth: embedded ? 0 : layout.hairline,
    borderBottomColor: color.line, backgroundColor: color.canvas, flexShrink: 0 }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: space.x3 }}>
      <View style={{ flexDirection: 'row', gap: space.x3, flexGrow: 1, flexShrink: 1,
        flexBasis: isDesktop ? 280 : '100%', minWidth: 0 }}>
        {back ? <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={back}
          style={({ pressed }) => ({ width: 44, height: 44, borderRadius: radius.sm,
            alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? color.sunken : color.surface })}>
          <Feather name="arrow-left" size={20} color={color.ink} />
        </Pressable> : null}
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          {overline ? <Text style={{ fontFamily: font.medium, fontSize: 13, lineHeight: 20, color: color.inkMid }}>{overline}</Text> : null}
          <Text accessibilityRole="header" aria-level={1} style={{ fontFamily: font.semibold, fontWeight: '600',
            fontSize: dense ? 20 : 24, lineHeight: dense ? 28 : 32,
            letterSpacing: isPhone ? -0.5 : -0.9, color: color.ink }}>{title}</Text>
          {subtitle ? <Text style={{ fontFamily: font.regular, fontSize: isPhone ? 16 : 15,
            lineHeight: 22, color: color.inkMid, maxWidth: 680 }}>{subtitle}</Text> : null}
        </View>
      </View>
      {actions ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.x2,
        alignItems: 'center', maxWidth: '100%', flexShrink: 1,
        flexBasis: isPhone ? '100%' : undefined }}>{actions}</View> : null}
    </View>
  </View>;
}
