// @ts-nocheck
import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";
import { color } from "@/src/design/tokens";
import { WEB_SYSTEM_FONT_STACK } from "@/src/components/appTextFamily";

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en" style={{ height: "100%", overflowX: "clip", "--forge-focus": color.focus }}>
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />
        {/*
          Disable body scrolling on web to make ScrollView components work correctly.
          If you want to enable scrolling, remove `ScrollViewStyleReset` and
          set `overflow: auto` on the body style below.
        */}
        <ScrollViewStyleReset />
        <link rel="stylesheet" href="/sales-interface.css" />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              html { color-scheme: light; --forge-default-viewport-height: 100%; }
              @supports (height: 100dvh) {
                html { --forge-default-viewport-height: 100dvh; }
              }
              @supports (height: 100svh) {
                /* Measure normal browser chrome independently of the visual viewport. */
                html::before {
                  content: ""; position: fixed; width: 0; height: 100svh; visibility: hidden; pointer-events: none;
                }
              }
              html[data-keyboard-open] { --forge-overlay-bottom-inset: 0px; }
              html[data-keyboard-open] [data-keyboard-action-bar="true"] { display: none !important; }
              @media (any-pointer: coarse) {
                html { --forge-input-font-floor: 16px; }
              }
              @media (pointer: fine) {
                [data-driver-options="true"] {
                  max-block-size: min(15rem, 28vh); overflow-y: auto;
                }
              }
              body, input, textarea, select, button { font-family: ${WEB_SYSTEM_FONT_STACK}; }
              body { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
              :is(button, a, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [tabindex]):focus-visible {
                outline: 3px solid ${color.focus} !important;
                outline-offset: 3px !important;
              }
              /* Composite controls paint focus on their rounded outer shell. */
              [data-field-shell="true"]:focus-within { box-shadow: 0 0 0 2px ${color.focus}; }
              [data-field-shell="true"] :is(input, textarea):focus { outline: none !important; box-shadow: none !important; }
              :is(input, textarea, select):focus-visible { outline: none !important; box-shadow: 0 0 0 2px ${color.focus}; }
              @media (forced-colors: active) {
                [data-field-shell="true"]:focus-within, :is(input, textarea, select):focus-visible { outline: 2px solid Highlight !important; outline-offset: 2px; }
              }
              .kitchen-date-input::-webkit-calendar-picker-indicator { display: none; }
              :is(input, textarea)::placeholder { opacity: 1; }
              :is(button, [role="button"], [role="tab"]) { touch-action: manipulation; }
              @media (prefers-reduced-motion: reduce) {
                *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }
              }
              #root { position: fixed !important; top: var(--forge-visible-top, 0px); left: 0; right: 0; bottom: auto !important; height: var(--forge-visible-height, var(--forge-default-viewport-height)) !important; }
              /* React Native Web portals sit outside the application root.
                 Resize only their outer modal, leaving inner dialog panels alone. */
              [aria-modal="true"]:not([aria-modal="true"] [aria-modal="true"]) { top: var(--forge-visible-top, 0px) !important; bottom: auto !important; height: var(--forge-visible-height, var(--forge-default-viewport-height)) !important; }
              input, textarea { scroll-margin-block: 12px; }
              [role="tablist"] [role="tab"] * { overflow: visible !important; }
              [role="heading"], [role="heading"] * { overflow: visible !important; }
            `,
          }}
        />
      </head>
      <body
        style={{
          margin: 0,
          height: "100%",
          overflow: "hidden",
          overflowX: "clip",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
      </body>
    </html>
  );
}
