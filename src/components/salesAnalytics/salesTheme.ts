import { colors } from '@/src/theme/tokens';

// Reference layouts retain the existing Buildcon palette.
export function useSalesTheme() {
 return {
  canvas: colors.surface,
  surface: colors.surfaceSecondary,
  ink: colors.onSurface,
  muted: colors.onSurfaceMuted,
  line: colors.border,
  accent: colors.brand,
  tint: colors.brandTint,
  header: colors.brand,
  highlight: colors.brandTint,
 };
}
