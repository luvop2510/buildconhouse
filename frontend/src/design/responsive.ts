// Responsive — the single breakpoint authority for the design system.
import { useWindowDimensions } from "react-native";

import { layout } from "./tokens";

/** The only supported viewport tiers for application layout. */
export type Bp = "phone" | "tabletPortrait" | "tabletLandscape" | "desktop";

export function useBp() {
  const { width, height } = useWindowDimensions();
  const bp: Bp =
    width >= layout.bp.desktop ? "desktop" :
    width >= layout.bp.tabletLandscape ? "tabletLandscape" :
    width >= layout.bp.tabletPortrait ? "tabletPortrait" : "phone";

  const isPhone = bp === "phone";
  const isTablet = bp === "tabletPortrait" || bp === "tabletLandscape";
  const isDesktop = bp === "desktop";
  const isTabletPortrait = bp === "tabletPortrait";
  const isTabletLandscape = bp === "tabletLandscape";

  const gutter = isPhone ? layout.gutter.phone : isTablet ? layout.gutter.tablet : layout.gutter.desktop;

  return { bp, width, height, isPhone, isTablet, isDesktop, isTabletPortrait, isTabletLandscape, gutter };
}

/**
 * The quotation builder responds to its usable container, not merely the
 * device viewport (the admin rail consumes part of the latter). Keep those
 * content thresholds here so the builder does not create a second breakpoint
 * system beside the app-wide viewport contract.
 */
export function quotationBuilderLayout(containerWidth: number, railCollapsed: boolean) {
  const threePane = containerWidth >= 1180;
  const twoPane = !threePane && containerWidth >= 740;

  return {
    threePane,
    twoPane,
    railWidth: railCollapsed ? 56 : containerWidth >= 1400 ? 260 : 240,
    quotationWidth: containerWidth >= 1440 ? 480 : containerWidth >= 1200 ? 440 : 400,
  };
}
