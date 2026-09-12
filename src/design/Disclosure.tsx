import { Feather } from '@expo/vector-icons';
import React, { useId, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { color, font, space } from './tokens';

/** Optional fields remain in parent state when this section is collapsed. */
export function Disclosure({ title, children, summary, defaultOpen = false }: {
  title: string; summary?: string; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return <View style={{ gap: space.x3, borderTopWidth: 1, borderTopColor: color.line }}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }}
      aria-expanded={open} aria-controls={id} onPress={() => setOpen(value => !value)}
      style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <View style={{ flex: 1, gap: 2 }}><Text style={{ color: color.ink, fontFamily: font.medium, fontWeight: '500', fontSize: 15 }}>{title}</Text>{summary ? <Text style={{ color: color.inkMid, fontFamily: font.regular, fontSize: 13 }}>{summary}</Text> : null}</View>
      <Feather name={open ? 'chevron-up' : 'chevron-down'} size={18} color={color.inkMid} />
    </Pressable>
    {open ? <View nativeID={id} style={{ gap: space.x4 }}>{children}</View> : null}
  </View>;
}
