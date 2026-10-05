import { useEffect, useState } from 'react';
import { Platform, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { color, font } from './tokens';

/** Connectivity feedback only. Reconnection never replays a business mutation. */
export function ConnectionStatus() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const update = () => setOffline(!navigator.onLine);
    update(); window.addEventListener('offline', update); window.addEventListener('online', update);
    return () => { window.removeEventListener('offline', update); window.removeEventListener('online', update); };
  }, []);
  if (!offline) return null;
  return <View role="status" accessibilityLiveRegion="polite" testID="connection-offline"
    style={{ paddingHorizontal: 16, paddingVertical: 10, backgroundColor: color.warnTint }}>
    <Text style={{ color: color.warn, fontFamily: font.medium, fontSize: 14, lineHeight: 20 }}>
      You’re offline. Keep this page open and reconnect before saving changes.
    </Text>
  </View>;
}
