import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import { Platform, Pressable, ScrollView, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { color, font, radius, space } from './tokens';

export function NavigationTabs<T extends string>({ value, options, onChange, testID, fullWidth, disabled = false, segmented = false }: {
  value: T; options: { value: T; label: string; count?: number; icon?: keyof typeof Feather.glyphMap }[];
  onChange: (value: T) => void; testID?: string; fullWidth?: boolean; disabled?: boolean; segmented?: boolean;
}) {
  const tabs = <View role="tablist" style={{ flexDirection: 'row', gap: segmented ? 4 : space.x5,
    padding: segmented ? 4 : 0, backgroundColor: segmented ? color.sunken : 'transparent',
    borderRadius: radius.sm, flexGrow: fullWidth ? 1 : undefined }}>
    {options.map((option, index) => {
      const active = value === option.value;
      return <Pressable key={option.value}
        testID={testID ? `${testID}-${option.value}` : undefined} role="tab"
        aria-selected={active} accessibilityLabel={option.label} accessibilityState={{ selected: active, disabled }} disabled={disabled}
        tabIndex={active ? 0 : -1} onPress={() => onChange(option.value)}
        {...(Platform.OS === 'web' ? { onKeyDown: (event: React.KeyboardEvent) => {
          if (disabled) return;
          const next = event.key === 'ArrowRight' ? (index + 1) % options.length
            : event.key === 'ArrowLeft' ? (index + options.length - 1) % options.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault(); onChange(options[next].value);
          // Let the selected state commit before moving DOM focus. Focusing
          // the previous render here can be dropped when the tablist rerenders.
          requestAnimationFrame(() => {
            const nextValue = String(options[next].value);
            const target = testID
              ? document.querySelector<HTMLElement>(`[data-testid="${testID}-${nextValue}"]`)
              : Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'))
                .find(tab => tab.getAttribute('aria-label') === options[next].label);
            target?.focus();
          });
        }} : {})}
        style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: segmented ? 10 : 2,
          flex: fullWidth ? 1 : undefined, flexShrink: 0, flexDirection: 'row', gap: 6,
          alignItems: 'center', justifyContent: 'center', borderRadius: segmented ? radius.sm : 0,
          borderBottomWidth: segmented ? 0 : 2, borderBottomColor: active ? color.action : 'transparent',
          backgroundColor: segmented && active ? color.surface : pressed ? color.hoverWash : 'transparent' })}>
        {option.icon ? <Feather name={option.icon} size={15} color={active ? color.action : color.inkSoft} /> : null}
        <Text style={{ fontFamily: active ? font.semibold : font.medium, fontWeight: active ? '600' : '500',
          fontSize: 13, lineHeight: 18, color: active ? color.ink : color.inkMid }}>{option.label}</Text>
        {typeof option.count === 'number' ? <Text style={{ fontSize: 12, color: color.inkSoft }}>{option.count}</Text> : null}
      </Pressable>;
    })}
  </View>;
  return <ScrollView horizontal testID={testID} showsHorizontalScrollIndicator={false}
    style={{ flexGrow: 0, flexShrink: 0, maxWidth: '100%' }} contentContainerStyle={{ flexGrow: fullWidth ? 1 : undefined }}>
    {tabs}
  </ScrollView>;
}
