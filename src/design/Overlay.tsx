import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View, ViewStyle, useWindowDimensions } from "react-native";
import { Text } from "@/src/components/AppText";
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useReducedMotion } from '@/src/hooks/use-reduced-motion';
import { useBp } from './responsive';
import { color, font, radius, shadow, space } from './tokens';
import { useOverlayFocus } from './useOverlayFocus';

export type OverlayProps = {
  open: boolean; onClose: () => void; title?: string; subtitle?: string;
  children: React.ReactNode; footer?: React.ReactNode; headerRight?: React.ReactNode;
  width?: number; maxHeight?: number; minHeight?: ViewStyle['minHeight']; testID?: string;
  header?: boolean; dismissable?: boolean; scroll?: boolean; presentation?: 'dialog' | 'drawer' | 'bottom' | 'fullscreen';
  returnFocusRef?: React.RefObject<View | null>;
};

/** Shared native/web modal boundary. Existing sheets adapt their prop names here. */
export function Overlay({ open, onClose, title, subtitle, children, footer, headerRight,
  width = 520, maxHeight = .92, minHeight, testID, dismissable = true,
  header = true, scroll = true, presentation = 'dialog', returnFocusRef }: OverlayProps) {
  const { isPhone } = useBp();
  const { height, width: viewportWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const panelRef = useOverlayFocus(open, onClose, dismissable, returnFocusRef);
  const bottom = presentation === 'bottom' || (isPhone && presentation !== 'fullscreen');
  const drawer = !isPhone && presentation === 'drawer';
  const fullscreen = presentation === 'fullscreen';
  const visibleHeight = Platform.OS === 'web' ? `calc(var(--forge-visible-height, 100dvh) * ${maxHeight})` as unknown as number : height * maxHeight;
  const panelPadding = isPhone ? space.x4 : space.x5;
  const content = scroll ? <ScrollView keyboardShouldPersistTaps="handled"
    style={{ flexShrink: 1, minHeight: 0 }} contentContainerStyle={{ padding: panelPadding, gap: space.x4 }}>{children}</ScrollView>
    : <View style={{ flex: 1, minHeight: 0 }}>{children}</View>;
  return <Modal visible={open} transparent animationType={Platform.OS === 'web' || reducedMotion ? 'none' : 'fade'}
    onRequestClose={dismissable ? onClose : undefined} statusBarTranslucent>
    <KeyboardAvoidingView enabled={Platform.OS !== 'web'} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
      <View style={{ flex: 1, backgroundColor: color.scrim, justifyContent: bottom ? 'flex-end' : 'center',
        alignItems: drawer ? 'flex-end' : 'center', padding: bottom || drawer || fullscreen ? 0 : space.x5 }}>
        {dismissable ? <Pressable tabIndex={-1} accessibilityLabel="Dismiss dialog" onPress={onClose}
          style={{ position: 'absolute', inset: 0 }} /> : null}
        <View ref={panelRef} testID={testID} role="dialog" aria-modal={true} tabIndex={-1}
          accessibilityViewIsModal accessibilityLabel={title || 'Dialog'}
          style={{ backgroundColor: color.surface, ...shadow.overlay, overflow: 'hidden', flexShrink: 1,
            width: bottom || fullscreen ? '100%' : Math.min(width, viewportWidth - (drawer ? 0 : 40)),
            height: fullscreen || drawer ? '100%' : !scroll ? visibleHeight : undefined,
            maxHeight: fullscreen || drawer ? '100%' : visibleHeight, minHeight,
            borderRadius: bottom || fullscreen ? 0 : radius.xl,
            borderTopLeftRadius: fullscreen ? 0 : radius.xl, borderTopRightRadius: drawer || fullscreen ? 0 : radius.xl,
            paddingTop: fullscreen ? insets.top : 0, paddingBottom: bottom || fullscreen ? insets.bottom : 0 }}>
          {header ? <View style={{ flexDirection: 'row', flexShrink: 0, alignItems: 'flex-start', gap: space.x3,
            padding: panelPadding, borderBottomWidth: 1, borderBottomColor: color.line }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              {title ? <Text accessibilityRole="header" aria-level={2} style={{ color: color.ink,
                fontFamily: font.semibold, fontWeight: '600', fontSize: 20, lineHeight: 28 }}>{title}</Text> : null}
              {subtitle ? <Text style={{ fontFamily: font.regular, fontSize: 14, lineHeight: 21, color: color.inkMid }}>{subtitle}</Text> : null}
            </View>
            {headerRight}
            {dismissable ? <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose}
              testID={testID ? `${testID}-close` : undefined} style={{ width: 44, height: 44,
                alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, backgroundColor: color.canvas }}>
              <Feather name="x" size={20} color={color.inkMid} />
            </Pressable> : null}
          </View> : null}
          {content}
          {footer ? <View style={{ padding: panelPadding, flexShrink: 0, borderTopWidth: 1, borderTopColor: color.line,
            flexDirection: 'row', flexWrap: 'wrap', gap: space.x3 }}>{footer}</View> : null}
        </View>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}
